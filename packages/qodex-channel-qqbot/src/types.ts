export interface QQBotMessageAttachment {
  content_type?: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  url?: string;
}

export interface QQBotC2CMessageEvent {
  author: {
    id?: string;
    union_openid?: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  attachments?: QQBotMessageAttachment[];
}

export interface QQBotGuildMessageEvent {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string;
  };
  attachments?: QQBotMessageAttachment[];
}

export interface QQBotGroupMessageEvent {
  author: {
    id?: string;
    member_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  group_id?: string;
  group_openid: string;
  attachments?: QQBotMessageAttachment[];
}

export interface QQBotWSHelloData {
  heartbeat_interval: number;
}

export interface QQBotWSReadyData {
  session_id: string;
  user?: {
    id?: string;
    username?: string;
    bot?: boolean;
  };
}

export interface QQBotWSPayload<T = unknown> {
  op: number;
  d?: T;
  s?: number;
  t?: string;
  id?: string;
}
