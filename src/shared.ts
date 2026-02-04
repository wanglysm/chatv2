// User types
export type User = {
	id: string;
	username: string;
	nickname?: string;
	role: "admin" | "user";
	avatar?: string;
	created_at: number;
};

export type UserWithPassword = User & {
	password: string;
};

// Room types
export type Room = {
	id: string;
	name: string;
	type: "private" | "group" | "bot";
	avatar?: string;
	created_at: number;
};

export type RoomMember = {
	room_id: string;
	user_id: string;
	joined_at: number;
};

// Message content types
export type MessageContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mime_type: string; name?: string; width?: number; height?: number }
	| { type: "audio"; data: string; mime_type: string; duration?: number; name?: string }
	| { type: "video"; data: string; mime_type: string; duration?: number; width?: number; height?: number; name?: string }
	| { type: "file"; data: string; mime_type: string; name?: string; size?: number }
	| { type: "location"; latitude: number; longitude: number; address?: string }
	| { type: "card"; title: string; description?: string; url?: string; image?: string };

// Message types
export type Message = {
	id: string;
	room_id: string;
	user_id: string;
	content: string;
	content_type: "text" | "image" | "audio" | "video" | "file" | "location" | "card";
	created_at: number;
	source?: "user" | "bot";
	external_id?: string;
	acknowledged?: boolean;
};

// Session types
export type Session = {
	id: string;
	user_id: string;
	created_at: number;
	expires_at: number;
};

// WebSocket message types
export type WSMessage =
	| { type: "auth"; session_id: string }
	| { type: "auth_success"; user_id: string }
	| { type: "auth_error"; message: string }
	| { type: "ping"; timestamp: number }
	| { type: "pong"; timestamp: number }
	| { type: "join_room"; room_id: string }
	| { type: "leave_room"; room_id: string }
	| { type: "room_joined"; room_id: string }
	| { type: "room_left"; room_id: string }
	| { type: "new_message"; message: Message; user: User }
	| { type: "message_ack"; message_id: string; status: "delivered" | "read" }
	| { type: "room_messages"; room_id: string; messages: Message[]; users: User[] }
	| { type: "sync_request"; last_message_id?: string }
	| { type: "sync_response"; messages: Message[]; users: User[] }
	| { type: "user_online"; user_id: string }
	| { type: "user_offline"; user_id: string }
	| { type: "room_deleted"; room_id: string }
	| { type: "error"; message: string };

// Bot WebSocket message types
export type BotWSMessage =
	| { type: "auth"; api_key: string }
	| { type: "auth_success" }
	| { type: "auth_error"; message: string }
	| { type: "ping"; timestamp: number }
	| { type: "pong"; timestamp: number }
	| { type: "subscribe"; room_id: string }
	| { type: "unsubscribe"; room_id: string }
	| { type: "user_message"; room_id: string; user_id: string; content: string; timestamp: number }
	| { type: "send_message"; room_id: string; content: string; content_type?: string; external_id?: string }
	| { type: "message_sent"; message_id: string; external_id?: string }
	| { type: "error"; message: string };

// API types
export type APIResponse<T = unknown> = {
	success: boolean;
	data?: T;
	error?: string;
};

// Request types
export type LoginRequest = {
	username: string;
	password: string;
};

export type CreateUserRequest = {
	username: string;
	password: string;
	role?: "admin" | "user";
};

export type CreateRoomRequest = {
	name: string;
	type: "private" | "group" | "bot";
	member_ids?: string[];
};

export type SendMessageRequest = {
	room_id: string;
	content: string;
	content_type?: "text" | "image" | "audio" | "video" | "file" | "location" | "card";
};

export type ChangePasswordRequest = {
	old_password: string;
	new_password: string;
};

export type ChangeNicknameRequest = {
	nickname: string;
};

// Connection attachment types
export type ConnectionAttachment =
	| { type: "user"; userId: string; joinedRooms: string[]; lastPing: number }
	| { type: "bot"; botId: string; subscribedRooms: string[]; lastPing: number };
