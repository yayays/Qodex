# Codex Workspace File Ingress Design

## Goal

Let Qodex accept inbound files from QQ and WeChat, materialize them into the conversation-bound workspace, and return the final saved paths to the user, without automatically injecting those paths into the Codex prompt.

This design assumes users will explicitly reference saved file paths in later messages when they want Codex to read those files from the workspace.

## Problem

Qodex now supports:

- inbound `files[]` metadata across edge, channel host, and core request boundaries
- QQ non-image attachments mapped into `files[]`
- WeChat compatibility transport file items mapped into `files[]`

Qodex does not yet support:

- downloading or copying inbound files into the bound workspace
- a stable workspace-visible destination layout for uploaded files
- user-visible delivery of the final saved file paths

The current state means file metadata survives ingress, but the actual files do not become available inside the workspace that Codex can access.

## Non-Goals

- no automatic prompt injection of file paths into Codex input
- no direct OpenAI `input_file` upload flow in this slice
- no document text extraction or parsing
- no background indexing or automatic file discovery
- no new generic media storage service outside the existing workspace model
- no attempt to make uploaded files automatically usable in the same turn without explicit user reference

## Recommended Approach

Use a two-stage workspace materialization flow in `qodex-core`:

1. stage inbound files in a per-conversation inbox under the bound workspace
2. move or copy them into a user-visible dated folder under the workspace
3. return the final saved paths to edge so the user receives a confirmation message

Directory strategy:

- temporary inbox: `<workspace>/.qodex/inbox/<conversation-key>/`
- final destination: `<workspace>/uploadfile/YYYY-MM-DD/`

Naming strategy:

- preserve the original filename when available
- if a collision exists, append `-2`, `-3`, and so on before the extension

This keeps downloads isolated during transfer, produces stable user-facing paths, and fits the current Codex workspace model without introducing a second file authority.

## Alternatives Considered

### 1. Store files only in `.qodex/inbox`

Pros:

- smallest implementation
- keeps all ingress artifacts in one hidden internal area

Cons:

- awkward for users to reference later
- feels internal rather than workspace-native

### 2. Directly save into `uploadfile/YYYY-MM-DD/`

Pros:

- less code
- no move step

Cons:

- partial downloads can leave broken files in the visible destination
- weaker boundary between transfer state and completed files

### 3. Upload files to OpenAI and pass `input_file` to Codex

Pros:

- can make files immediately available as model input

Cons:

- larger scope and external lifecycle management
- not aligned with the chosen user flow where later messages reference workspace paths
- OpenAI docs clearly cover PDF file input, but not a broad guarantee for arbitrary file types

Recommendation:

Keep this slice workspace-native. Save files into the bound workspace and tell the user where they landed.

## Architecture

### New Responsibilities

- `qodex-core`
  - owns file materialization because it already resolves and validates the effective workspace
  - stages remote downloads and local file copies/moves
  - returns saved file results alongside normal message acceptance

- `qodex-edge`
  - remains a thin transport layer
  - forwards `files[]` to core
  - sends a user-visible confirmation message when core reports saved files

- `channel plugins`
  - continue to identify inbound files
  - do not choose final workspace paths
  - do not emit final save confirmations independently

### Existing Units Expected To Change

- `crates/qodex-core/src/protocol.rs`
  - extend `SendMessageResponse` with saved file results
- `crates/qodex-core/src/service.rs`
  - materialize inbound files before backend turn start
- `crates/qodex-core/src/service/`
  - add a focused helper module for inbound file staging and destination resolution
- `packages/qodex-edge/src/core-protocol.ts`
  - mirror saved file response fields
- `packages/qodex-edge/src/runtime/inbound.ts`
  - emit user-facing path confirmations from saved file results

## Data Flow

### Inbound File Path

1. QQ or WeChat channel emits inbound `files[]`.
2. Edge forwards `files[]` through runtime to `qodex-core`.
3. Core resolves the effective workspace for the conversation.
4. For each inbound file:
   - if remote URL: download to `<workspace>/.qodex/inbox/<conversation-key>/`
   - if local path: copy or move into the staging area if needed, or materialize directly through the same helper path
5. Core computes the final dated destination under `<workspace>/uploadfile/YYYY-MM-DD/`.
6. Core resolves filename conflicts by suffixing the basename.
7. Core moves the completed staged file into the final destination.
8. Core returns the saved file records in `SendMessageResponse`.
9. Edge sends a confirmation message listing the saved paths.
10. The original user text still flows to Codex unchanged.

### No Automatic Prompt Injection

Core does not append any saved path hints to the effective text for Codex.

The saved files are available only because they now exist in the workspace. If the user wants Codex to use them, the user must mention the path in a later message.

## File Materialization Rules

### Remote Files

- require a remote URL from channel ingress
- download into the hidden inbox first
- only expose the file in `uploadfile/YYYY-MM-DD/` after the download completes

### Local Files

- accept an existing local path from channel ingress
- if the path already lies under the same final workspace destination, keep behavior simple and still resolve the final canonical path through the helper
- prefer copy semantics over destructive move unless a source is explicitly marked safe to move

### Final Save Records

Core should return a record shaped roughly like:

```json
{
  "filename": "report.pdf",
  "savedPath": "/workspace/uploadfile/2026-03-25/report.pdf",
  "source": "remote",
  "url": "https://cdn.example.com/report.pdf",
  "status": "saved"
}
```

For failed items, core should return:

```json
{
  "filename": "report.pdf",
  "source": "remote",
  "url": "https://cdn.example.com/report.pdf",
  "status": "failed",
  "error": "download timed out"
}
```

## Error Handling

### Partial Failure

One failed file must not discard successfully saved files from the same inbound message.

### Text Flow Independence

If file materialization fails but the user also sent text, the text still goes to Codex. This slice treats file saving as additive, not a hard precondition for normal conversation.

### Workspace Validation

If there is no valid workspace for the conversation, file materialization fails fast and no save attempt is made.

### User Feedback

Edge should send a concise confirmation summary:

- saved files with final paths
- failed files with reasons

This summary should be a normal outbound text message on the current conversation sink.

## Testing

### Core Tests

- remote file downloads into the inbox and ends in `uploadfile/YYYY-MM-DD/`
- local file input copies into the final destination
- duplicate filenames gain suffixes
- invalid workspace blocks saving
- partial failures still return successful saved files
- text-only message handling still works when file saving fails
- `SendMessageResponse` includes saved file results

### Edge Tests

- runtime emits a save confirmation when core returns saved files
- runtime emits failure details for failed file saves
- runtime behavior remains unchanged when no saved files are returned

### Channel Regression

- QQ non-image attachments still populate `files[]`
- WeChat file items still populate `files[]`

## Open Questions

- whether local-path file inputs should always be copied or conditionally moved based on source metadata
- whether image attachments should remain image-only for this slice or also be materialized as files in a later slice
- whether the save confirmation should be `system` or `final` kind for the best channel UX

## Recommendation

Implement the two-stage workspace materialization flow in core now, return saved file paths to edge, and keep Codex prompt text untouched. This is the smallest coherent slice that makes uploaded files actually usable in the workspace while preserving the user-controlled workflow you chose.
