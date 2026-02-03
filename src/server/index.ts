import { Server, routePartykitRequest } from "partyserver";
import type { Connection } from "partyserver";
import type {
	User,
	UserWithPassword,
	Room,
	Message,
	RoomMember,
	Session,
	WSMessage,
	BotWSMessage,
	APIResponse,
	LoginRequest,
	CreateUserRequest,
	CreateRoomRequest,
	SendMessageRequest,
	ChangePasswordRequest,
	ChangeNicknameRequest,
	ConnectionAttachment,
} from "../shared";

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds

export class ChatV2 extends Server<Env> {
	static options = { hibernate: true };

	onStart() {
		this.initializeDatabase();
		this.startHeartbeatCheck();
	}

	initializeDatabase() {
		// Users table
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				username TEXT UNIQUE NOT NULL,
				password TEXT NOT NULL,
				nickname TEXT,
				role TEXT NOT NULL DEFAULT 'user',
				avatar TEXT,
				created_at INTEGER NOT NULL
			)
		`);

		// Rooms table
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS rooms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				type TEXT NOT NULL,
				avatar TEXT,
				created_at INTEGER NOT NULL
			)
		`);

		// Messages table with acknowledgment support
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				content TEXT NOT NULL,
				content_type TEXT DEFAULT 'text',
				created_at INTEGER NOT NULL,
				source TEXT DEFAULT 'user',
				external_id TEXT,
				acknowledged INTEGER DEFAULT 0,
				FOREIGN KEY (room_id) REFERENCES rooms(id),
				FOREIGN KEY (user_id) REFERENCES users(id)
			)
		`);

		// Migration: Add content_type column if it doesn't exist (for existing databases)
		const tableInfo = this.ctx.storage.sql.exec(`PRAGMA table_info(messages)`).toArray();
		const hasContentType = tableInfo.some((col) => col.name === 'content_type');
		if (!hasContentType) {
			this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN content_type TEXT DEFAULT 'text'`);
		}

		// Room members table
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS room_members (
				room_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (room_id, user_id),
				FOREIGN KEY (room_id) REFERENCES rooms(id),
				FOREIGN KEY (user_id) REFERENCES users(id)
			)
		`);

		// Sessions table
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				FOREIGN KEY (user_id) REFERENCES users(id)
			)
		`);

		// Bot config table
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS bot_config (
				id TEXT PRIMARY KEY,
				api_key TEXT NOT NULL UNIQUE,
				enabled INTEGER DEFAULT 1,
				created_at INTEGER NOT NULL
			)
		`);

		this.createDefaultData();
	}

	createDefaultData() {
		// Create admin user if not exists
		const adminExists = this.ctx.storage.sql.exec(`SELECT * FROM users WHERE username = 'admin'`).toArray();
		if (adminExists.length === 0) {
			const adminId = this.generateId();
			const now = Date.now();
			this.ctx.storage.sql.exec(`
				INSERT INTO users (id, username, password, role, created_at)
				VALUES ('${adminId}', 'admin', '${this.hashPassword("admin123")}', 'admin', ${now})
			`);
		}

		// Create bot user if not exists
		const botExists = this.ctx.storage.sql.exec(`SELECT * FROM users WHERE id = 'bot'`).toArray();
		if (botExists.length === 0) {
			const now = Date.now();
			this.ctx.storage.sql.exec(`
				INSERT INTO users (id, username, password, role, avatar, created_at)
				VALUES ('bot', 'AI助手', '', 'user', '🤖', ${now})
			`);
		}

		// Create default bot config
		const configExists = this.ctx.storage.sql.exec(`SELECT * FROM bot_config`).toArray();
		if (configExists.length === 0) {
			const now = Date.now();
			const apiKey = this.env.BOT_API_KEY || "default-bot-api-key";
			this.ctx.storage.sql.exec(`
				INSERT INTO bot_config (id, api_key, enabled, created_at)
				VALUES ('${this.generateId()}', '${apiKey}', 1, ${now})
			`);
		}
	}

	generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
	}

	hashPassword(password: string): string {
		let hash = 0;
		for (let i = 0; i < password.length; i++) {
			const char = password.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return hash.toString(16);
	}

	verifyPassword(password: string, hash: string): boolean {
		return this.hashPassword(password) === hash;
	}

	// Start heartbeat check interval
	startHeartbeatCheck() {
		setInterval(() => {
			const now = Date.now();
			for (const connection of this.ctx.getWebSockets()) {
				const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
				if (attachment && (attachment.type === "user" || attachment.type === "bot")) {
					if (now - attachment.lastPing > HEARTBEAT_TIMEOUT) {
					connection.close();
				}
				}
			}
		}, HEARTBEAT_INTERVAL);
	}

	// HTTP API handlers
	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// Auth endpoints
			if (path === "/api/login" && request.method === "POST") {
				return this.handleLogin(request);
			}

			// User endpoints
			if (path === "/api/users" && request.method === "GET") {
				return this.handleGetUsers(request);
			}
			if (path === "/api/users" && request.method === "POST") {
				return this.handleCreateUser(request);
			}

			// Room endpoints
			if (path === "/api/rooms" && request.method === "GET") {
				return this.handleGetRooms(request);
			}
			if (path === "/api/rooms" && request.method === "POST") {
				return this.handleCreateRoom(request);
			}
			if (path.startsWith("/api/rooms/") && request.method === "GET") {
				const roomId = path.split("/")[3];
				return this.handleGetRoomMessages(roomId, request);
			}
			if (path.startsWith("/api/rooms/") && request.method === "DELETE") {
				const roomId = path.split("/")[3];
				return this.handleDeleteRoom(roomId, request);
			}

			// Message endpoints
			if (path === "/api/messages" && request.method === "POST") {
				return this.handleSendMessage(request);
			}

			// User settings endpoints
			if (path === "/api/change-password" && request.method === "POST") {
				return this.handleChangePassword(request);
			}
			if (path === "/api/change-nickname" && request.method === "POST") {
				return this.handleChangeNickname(request);
			}

			return new Response(
				JSON.stringify({ success: false, error: "Not found" } as APIResponse),
				{ status: 404, headers: { "Content-Type": "application/json" } }
			);
		} catch (error) {
			return new Response(
				JSON.stringify({
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				} as APIResponse),
				{ status: 500, headers: { "Content-Type": "application/json" } }
			);
		}
	}

	async handleLogin(request: Request): Promise<Response> {
		const body = (await request.json()) as LoginRequest;
		const { username, password } = body;

		const users = this.ctx.storage.sql.exec(`SELECT * FROM users WHERE username = '${username}'`).toArray() as UserWithPassword[];

		if (users.length === 0 || !this.verifyPassword(password, users[0].password)) {
			return new Response(
				JSON.stringify({ success: false, error: "用户名或密码错误" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		const user = users[0];
		const sessionId = this.generateId();
		const now = Date.now();
		const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 days

		this.ctx.storage.sql.exec(`
			INSERT INTO sessions (id, user_id, created_at, expires_at)
			VALUES ('${sessionId}', '${user.id}', ${now}, ${expiresAt})
		`);

		const { password: _, ...userWithoutPassword } = user;

		return new Response(
			JSON.stringify({
				success: true,
				data: {
					session: { id: sessionId, user_id: user.id, created_at: now, expires_at: expiresAt },
					user: userWithoutPassword,
				},
			} as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async handleGetUsers(request: Request): Promise<Response> {
		const userId = await this.validateSession(request);
		if (!userId) {
			return new Response(
				JSON.stringify({ success: false, error: "Unauthorized" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		const users = this.ctx.storage.sql.exec(`
			SELECT id, username, nickname, role, avatar, created_at FROM users WHERE id != '${userId}'
		`).toArray() as User[];

		return new Response(
			JSON.stringify({ success: true, data: users } as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async handleCreateUser(request: Request): Promise<Response> {
		const currentUserId = await this.validateSession(request);
		if (!currentUserId) {
			return new Response(
				JSON.stringify({ success: false, error: "Unauthorized" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		// Check if current user is admin
		const currentUser = this.ctx.storage.sql.exec(`SELECT * FROM users WHERE id = '${currentUserId}'`).toArray()[0] as UserWithPassword;
		if (currentUser.role !== "admin") {
			return new Response(
				JSON.stringify({ success: false, error: "Permission denied" } as APIResponse),
				{ status: 403, headers: { "Content-Type": "application/json" } }
			);
		}

		const body = (await request.json()) as CreateUserRequest;
		const { username, password, role = "user" } = body;

		const existingUser = this.ctx.storage.sql.exec(`SELECT * FROM users WHERE username = '${username}'`).toArray();
		if (existingUser.length > 0) {
			return new Response(
				JSON.stringify({ success: false, error: "用户名已存在" } as APIResponse),
				{ status: 400, headers: { "Content-Type": "application/json" } }
			);
		}

		const userId = this.generateId();
		const now = Date.now();

		this.ctx.storage.sql.exec(`
			INSERT INTO users (id, username, password, role, created_at)
			VALUES ('${userId}', '${username}', '${this.hashPassword(password)}', '${role}', ${now})
		`);

		const newUser = this.ctx.storage.sql.exec(`SELECT id, username, nickname, role, avatar, created_at FROM users WHERE id = '${userId}'`).toArray()[0] as User;

		return new Response(
			JSON.stringify({ success: true, data: newUser } as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async handleGetRooms(request: Request): Promise<Response> {
		const userId = await this.validateSession(request);
		if (!userId) {
			return new Response(
				JSON.stringify({ success: false, error: "Unauthorized" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		const rooms = this.ctx.storage.sql.exec(`
			SELECT r.* FROM rooms r
			INNER JOIN room_members rm ON r.id = rm.room_id
			WHERE rm.user_id = '${userId}'
			ORDER BY r.created_at DESC
		`).toArray() as Room[];

		// For private rooms, show other user's name
		const roomsWithDisplayName = rooms.map((room) => {
			if (room.type === "private") {
				const members = this.ctx.storage.sql.exec(`SELECT * FROM room_members WHERE room_id = '${room.id}'`).toArray() as RoomMember[];
				const otherMember = members.find((m) => m.user_id !== userId);
				if (otherMember) {
					const otherUser = this.ctx.storage.sql.exec(`SELECT * FROM users WHERE id = '${otherMember.user_id}'`).toArray()[0] as User;
					if (otherUser) {
						return { ...room, name: otherUser.nickname || otherUser.username };
					}
				}
			}
			return room;
		});

		return new Response(
			JSON.stringify({ success: true, data: roomsWithDisplayName } as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async handleCreateRoom(request: Request): Promise<Response> {
		const userId = await this.validateSession(request);
		if (!userId) {
			return new Response(
				JSON.stringify({ success: false, error: "Unauthorized" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		const body = (await request.json()) as CreateRoomRequest;
		const { name, type, member_ids = [] } = body;

		// Check if private room already exists
		if (type === "private" && member_ids.length === 2) {
			const existingRoom = this.ctx.storage.sql.exec(`
				SELECT r.* FROM rooms r
				JOIN room_members rm1 ON r.id = rm1.room_id
				JOIN room_members rm2 ON r.id = rm2.room_id
				WHERE r.type = 'private'
				AND rm1.user_id = '${member_ids[0]}'
				AND rm2.user_id = '${member_ids[1]}'
				LIMIT 1
			`).toArray() as Room[];

			if (existingRoom.length > 0) {
				return new Response(
					JSON.stringify({ success: true, data: existingRoom[0] } as APIResponse),
					{ headers: { "Content-Type": "application/json" } }
				);
			}
		}

		const roomId = this.generateId();
		const now = Date.now();

		this.ctx.storage.sql.exec(`
			INSERT INTO rooms (id, name, type, created_at)
			VALUES ('${roomId}', '${name}', '${type}', ${now})
		`);

		// Add members
		if (type === "private" && member_ids.length === 2) {
			for (const memberId of member_ids) {
				this.ctx.storage.sql.exec(`
					INSERT INTO room_members (room_id, user_id, joined_at)
					VALUES ('${roomId}', '${memberId}', ${now})
				`);
			}
		} else if (type === "bot") {
			// Bot room: user + bot
			this.ctx.storage.sql.exec(`
				INSERT INTO room_members (room_id, user_id, joined_at)
				VALUES ('${roomId}', 'bot', ${now})
			`);
			if (member_ids.length > 0) {
				this.ctx.storage.sql.exec(`
					INSERT INTO room_members (room_id, user_id, joined_at)
					VALUES ('${roomId}', '${member_ids[0]}', ${now})
				`);
			}
		} else if (member_ids.length > 0) {
			for (const memberId of member_ids) {
				this.ctx.storage.sql.exec(`
					INSERT INTO room_members (room_id, user_id, joined_at)
					VALUES ('${roomId}', '${memberId}', ${now})
				`);
			}
		}

		const room = this.ctx.storage.sql.exec(`SELECT * FROM rooms WHERE id = '${roomId}'`).toArray()[0] as Room;

		return new Response(
			JSON.stringify({ success: true, data: room } as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async handleGetRoomMessages(roomId: string, request: Request): Promise<Response> {
		const userId = await this.validateSession(request);
		if (!userId) {
			return new Response(
				JSON.stringify({ success: false, error: "Unauthorized" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		// Check if user is member of the room
		const membership = this.ctx.storage.sql.exec(`
			SELECT * FROM room_members WHERE room_id = '${roomId}' AND user_id = '${userId}'
		`).toArray();
		if (membership.length === 0) {
			return new Response(
				JSON.stringify({ success: false, error: "Not a member of this room" } as APIResponse),
				{ status: 403, headers: { "Content-Type": "application/json" } }
			);
		}

		const messages = this.ctx.storage.sql.exec(`
			SELECT * FROM messages WHERE room_id = '${roomId}' ORDER BY created_at ASC LIMIT 100
		`).toArray() as unknown as Message[];

		const userIds = [...new Set(messages.map((m) => m.user_id))];
		const users: User[] = [];

		for (const uid of userIds) {
			if (uid === "bot") {
				users.push({
					id: "bot",
					username: "AI助手",
					role: "user",
					avatar: "🤖",
					created_at: Date.now(),
				});
			} else {
				const userResults = this.ctx.storage.sql.exec(`
					SELECT id, username, nickname, role, avatar, created_at FROM users WHERE id = '${uid}'
				`).toArray() as User[];
				if (userResults.length > 0) {
					users.push(userResults[0]);
				}
			}
		}

		return new Response(
			JSON.stringify({ success: true, data: { messages, users } } as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async handleDeleteRoom(roomId: string, request: Request): Promise<Response> {
		const userId = await this.validateSession(request);
		if (!userId) {
			return new Response(
				JSON.stringify({ success: false, error: "Unauthorized" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		const room = this.ctx.storage.sql.exec(`SELECT * FROM rooms WHERE id = '${roomId}'`).toArray()[0] as Room;
		if (!room) {
			return new Response(
				JSON.stringify({ success: false, error: "Room not found" } as APIResponse),
				{ status: 404, headers: { "Content-Type": "application/json" } }
			);
		}

		// Only allow deletion of bot rooms
		if (room.type !== "bot") {
			return new Response(
				JSON.stringify({ success: false, error: "Only bot rooms can be deleted" } as APIResponse),
				{ status: 403, headers: { "Content-Type": "application/json" } }
			);
		}

		this.ctx.storage.sql.exec(`DELETE FROM messages WHERE room_id = '${roomId}'`);
		this.ctx.storage.sql.exec(`DELETE FROM room_members WHERE room_id = '${roomId}'`);
		this.ctx.storage.sql.exec(`DELETE FROM rooms WHERE id = '${roomId}'`);

		return new Response(
			JSON.stringify({ success: true } as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async handleSendMessage(request: Request): Promise<Response> {
		const userId = await this.validateSession(request);
		if (!userId) {
			return new Response(
				JSON.stringify({ success: false, error: "Unauthorized" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		const body = (await request.json()) as SendMessageRequest;
		const { room_id, content, content_type = "text" } = body;

		const messageId = this.generateId();
		const now = Date.now();

		this.ctx.storage.sql.exec(
			`INSERT INTO messages (id, room_id, user_id, content, content_type, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			messageId,
			room_id,
			userId,
			content,
			content_type,
			now,
			'user'
		);

		const user = this.ctx.storage.sql.exec(`
			SELECT id, username, nickname, role, avatar, created_at FROM users WHERE id = '${userId}'
		`).toArray()[0] as User;

		// Broadcast to room members
		this.broadcastToRoom(room_id, {
			type: "new_message",
			message: {
				id: messageId,
				room_id,
				user_id: userId,
				content,
				content_type,
				created_at: now,
				source: "user",
			},
			user,
		});

		return new Response(
			JSON.stringify({ success: true, data: { message_id: messageId } } as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async handleChangePassword(request: Request): Promise<Response> {
		const userId = await this.validateSession(request);
		if (!userId) {
			return new Response(
				JSON.stringify({ success: false, error: "Unauthorized" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		const body = (await request.json()) as ChangePasswordRequest;
		const { old_password, new_password } = body;

		const user = this.ctx.storage.sql.exec(`SELECT * FROM users WHERE id = '${userId}'`).toArray()[0] as UserWithPassword;

		if (!this.verifyPassword(old_password, user.password)) {
			return new Response(
				JSON.stringify({ success: false, error: "旧密码错误" } as APIResponse),
				{ status: 400, headers: { "Content-Type": "application/json" } }
			);
		}

		this.ctx.storage.sql.exec(`
			UPDATE users SET password = '${this.hashPassword(new_password)}' WHERE id = '${userId}'
		`);

		return new Response(
			JSON.stringify({ success: true } as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async handleChangeNickname(request: Request): Promise<Response> {
		const userId = await this.validateSession(request);
		if (!userId) {
			return new Response(
				JSON.stringify({ success: false, error: "Unauthorized" } as APIResponse),
				{ status: 401, headers: { "Content-Type": "application/json" } }
			);
		}

		const body = (await request.json()) as ChangeNicknameRequest;
		const { nickname } = body;

		this.ctx.storage.sql.exec(`
			UPDATE users SET nickname = '${nickname.replace(/'/g, "''")}' WHERE id = '${userId}'
		`);

		return new Response(
			JSON.stringify({ success: true } as APIResponse),
			{ headers: { "Content-Type": "application/json" } }
		);
	}

	async validateSession(request: Request): Promise<string | null> {
		const authHeader = request.headers.get("Authorization");
		if (!authHeader || !authHeader.startsWith("Bearer ")) {
			return null;
		}

		const sessionId = authHeader.substring(7);
		const sessions = this.ctx.storage.sql.exec(`
			SELECT * FROM sessions WHERE id = '${sessionId}' AND expires_at > ${Date.now()}
		`).toArray() as Session[];

		if (sessions.length === 0) {
			return null;
		}

		return sessions[0].user_id;
	}

	// WebSocket handlers
	onConnect(connection: Connection) {
		// Connection established
	}

	onMessage(connection: Connection, message: string) {
		try {
			// Try parse as user message first
			const parsed = JSON.parse(message) as WSMessage | BotWSMessage | any;

			switch (parsed.type) {
				case "auth":
					if ("api_key" in parsed) {
						this.handleBotAuth(connection, parsed.api_key);
					} else {
						this.handleUserAuth(connection, parsed.session_id);
					}
					break;
				case "ping":
					this.handlePing(connection, parsed.timestamp);
					break;
				case "heartbeat":
					// Plugin-compatible heartbeat
					this.handleHeartbeat(connection);
					break;
				case "join_room":
					this.handleJoinRoom(connection, parsed.room_id);
					break;
				case "leave_room":
					this.handleLeaveRoom(connection, parsed.room_id);
					break;
				case "sync_request":
					this.handleSyncRequest(connection, parsed.last_message_id);
					break;
				case "message_ack":
					this.handleMessageAck(connection, parsed.message_id, parsed.status);
					break;
				// Bot specific messages
				case "subscribe":
					this.handleBotSubscribe(connection, parsed.room_id);
					break;
				case "unsubscribe":
					this.handleBotUnsubscribe(connection, parsed.room_id);
					break;
				case "send_message":
					this.handleBotSendMessage(connection, parsed.room_id, parsed.content, parsed.external_id);
					break;
				// Plugin-compatible message format
				case "message":
					if (parsed.message) {
						// Plugin format: { type: "message", message: { room_id, user_id, content, timestamp } }
						this.handlePluginMessage(connection, parsed.message);
					}
					break;
			}
		} catch (error) {
			connection.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
		}
	}

	onClose(connection: Connection) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (attachment?.type === "user") {
			// Notify other users that this user is offline
			this.broadcastUserStatus(attachment.userId, "offline");
		}
	}

	handleUserAuth(connection: Connection, sessionId: string) {

		const sessions = this.ctx.storage.sql.exec(`
			SELECT * FROM sessions WHERE id = '${sessionId}' AND expires_at > ${Date.now()}
		`).toArray() as Session[];

		if (sessions.length === 0) {
			connection.send(JSON.stringify({ type: "auth_error", message: "Invalid session" } as WSMessage));
			return;
		}

		const session = sessions[0];
		connection.serializeAttachment({
			type: "user",
			userId: session.user_id,
			joinedRooms: [],
			lastPing: Date.now(),
		} as ConnectionAttachment);

		connection.send(JSON.stringify({ type: "auth_success", user_id: session.user_id } as WSMessage));

		// Notify other users
		this.broadcastUserStatus(session.user_id, "online");
	}

	handleBotAuth(connection: Connection, apiKey: string) {
		// Check against environment variable
		const validApiKey = this.env.BOT_API_KEY || "default-bot-api-key";
		if (apiKey !== validApiKey) {
			connection.send(JSON.stringify({ type: "auth_error", message: "Invalid API key" } as BotWSMessage));
			connection.close();
			return;
		}

		connection.serializeAttachment({
			type: "bot",
			botId: "bot",
			subscribedRooms: [],
			lastPing: Date.now(),
		} as ConnectionAttachment);

		connection.send(JSON.stringify({ type: "auth_success" } as BotWSMessage));
	}

	handlePing(connection: Connection, timestamp: number) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (attachment) {
			attachment.lastPing = Date.now();
			connection.serializeAttachment(attachment);
		}

		connection.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
	}

	handleJoinRoom(connection: Connection, roomId: string) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (!attachment || attachment.type !== "user") {
			connection.send(JSON.stringify({ type: "error", message: "Not authenticated" } as WSMessage));
			return;
		}

		// Check if user is member of the room
		const membership = this.ctx.storage.sql.exec(`
			SELECT * FROM room_members WHERE room_id = '${roomId}' AND user_id = '${attachment.userId}'
		`).toArray();

		if (membership.length === 0) {
			connection.send(JSON.stringify({ type: "error", message: "Not a member of this room" } as WSMessage));
			return;
		}

		// Update joined rooms
		if (!attachment.joinedRooms.includes(roomId)) {
			attachment.joinedRooms.push(roomId);
			connection.serializeAttachment(attachment);
		}

		connection.send(JSON.stringify({ type: "room_joined", room_id: roomId } as WSMessage));

		// Send recent messages
		const messages = this.ctx.storage.sql.exec(`
			SELECT * FROM messages WHERE room_id = '${roomId}' ORDER BY created_at DESC LIMIT 50
		`).toArray() as unknown as Message[];

		const userIds = [...new Set(messages.map((m) => m.user_id))];
		const users: User[] = [];
		for (const uid of userIds) {
			if (uid === "bot") {
				users.push({ id: "bot", username: "AI助手", role: "user", avatar: "🤖", created_at: Date.now() });
			} else {
				const user = this.ctx.storage.sql.exec(`
					SELECT id, username, nickname, role, avatar, created_at FROM users WHERE id = '${uid}'
				`).toArray()[0] as User;
				if (user) users.push(user);
			}
		}

		connection.send(JSON.stringify({
			type: "room_messages",
			room_id: roomId,
			messages: messages.reverse(),
			users,
		} as WSMessage));
	}

	handleLeaveRoom(connection: Connection, roomId: string) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (attachment && attachment.type === "user") {
			attachment.joinedRooms = attachment.joinedRooms.filter((id) => id !== roomId);
			connection.serializeAttachment(attachment);
		}

		connection.send(JSON.stringify({ type: "room_left", room_id: roomId } as WSMessage));
	}

	handleSyncRequest(connection: Connection, lastMessageId?: string) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (!attachment || attachment.type !== "user") return;

		let query = `SELECT * FROM messages WHERE room_id IN (
			SELECT room_id FROM room_members WHERE user_id = '${attachment.userId}'
		)`;

		if (lastMessageId) {
			const lastMessage = this.ctx.storage.sql.exec(`SELECT created_at FROM messages WHERE id = '${lastMessageId}'`).toArray()[0] as unknown as Message;
			if (lastMessage) {
				query += ` AND created_at > ${lastMessage.created_at}`;
			}
		}

		query += ` ORDER BY created_at ASC LIMIT 100`;

		const messages = this.ctx.storage.sql.exec(query).toArray() as unknown as Message[];

		const userIds = [...new Set(messages.map((m) => m.user_id))];
		const users: User[] = [];
		for (const uid of userIds) {
			if (uid === "bot") {
				users.push({ id: "bot", username: "AI助手", role: "user", avatar: "🤖", created_at: Date.now() });
			} else {
				const user = this.ctx.storage.sql.exec(`
					SELECT id, username, nickname, role, avatar, created_at FROM users WHERE id = '${uid}'
				`).toArray()[0] as User;
				if (user) users.push(user);
			}
		}

		connection.send(JSON.stringify({
			type: "sync_response",
			messages,
			users,
		} as WSMessage));
	}

	handleMessageAck(connection: Connection, messageId: string, status: "delivered" | "read") {
		this.ctx.storage.sql.exec(`
			UPDATE messages SET acknowledged = 1 WHERE id = '${messageId}'
		`);
	}

	// Bot handlers
	handleBotSubscribe(connection: Connection, roomId: string) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (!attachment || attachment.type !== "bot") {
			connection.send(JSON.stringify({ type: "error", message: "Not authenticated as bot" } as BotWSMessage));
			return;
		}

		if (!attachment.subscribedRooms.includes(roomId)) {
			attachment.subscribedRooms.push(roomId);
			connection.serializeAttachment(attachment);
		}
	}

	handleBotUnsubscribe(connection: Connection, roomId: string) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (attachment && attachment.type === "bot") {
			attachment.subscribedRooms = attachment.subscribedRooms.filter((id) => id !== roomId);
			connection.serializeAttachment(attachment);
		}
	}

	handleBotSendMessage(connection: Connection, roomId: string, content: string, externalId?: string) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (!attachment || attachment.type !== "bot") {
			connection.send(JSON.stringify({ type: "error", message: "Not authenticated as bot" } as BotWSMessage));
			return;
		}

		const messageId = this.generateId();
		const now = Date.now();

		this.ctx.storage.sql.exec(`
			INSERT INTO messages (id, room_id, user_id, content, content_type, created_at, source, external_id)
			VALUES ('${messageId}', '${roomId}', 'bot', '${content.replace(/'/g, "''")}', 'text', ${now}, 'bot', '${externalId || ""}')
		`);

		// Broadcast to room members
		this.broadcastToRoom(roomId, {
			type: "new_message",
			message: {
				id: messageId,
				room_id: roomId,
				user_id: "bot",
				content,
				content_type: "text",
				created_at: now,
				source: "bot",
				external_id: externalId,
			},
			user: { id: "bot", username: "AI助手", role: "user", avatar: "🤖", created_at: now },
		});

		connection.send(JSON.stringify({
			type: "message_sent",
			message_id: messageId,
			external_id: externalId,
		} as BotWSMessage));
	}

	// Plugin-compatible heartbeat handler
	handleHeartbeat(connection: Connection) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (attachment) {
			attachment.lastPing = Date.now();
			connection.serializeAttachment(attachment);
		}
		// Plugin expects no response for heartbeat
	}

	// Plugin-compatible message handler
	handlePluginMessage(connection: Connection, messageData: { room_id: string; user_id: string; content: string; timestamp?: number }) {
		const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
		if (!attachment || attachment.type !== "bot") {
			connection.send(JSON.stringify({ type: "error", message: "Not authenticated as bot" }));
			return;
		}

		const { room_id, content } = messageData;

		// Check if bot is subscribed to this room
		if (!attachment.subscribedRooms.includes(room_id)) {
			attachment.subscribedRooms.push(room_id);
			connection.serializeAttachment(attachment);
		}

		const messageId = this.generateId();
		const now = Date.now();

		this.ctx.storage.sql.exec(`
			INSERT INTO messages (id, room_id, user_id, content, content_type, created_at, source)
			VALUES ('${messageId}', '${room_id}', 'bot', '${content.replace(/'/g, "''")}', 'text', ${now}, 'bot')
		`);

		// Broadcast to room members
		this.broadcastToRoom(room_id, {
			type: "new_message",
			message: {
				id: messageId,
				room_id,
				user_id: "bot",
				content,
				content_type: "text",
				created_at: now,
				source: "bot",
			},
			user: { id: "bot", username: "AI助手", role: "user", avatar: "🤖", created_at: now },
		});

		// Plugin-compatible response
		connection.send(JSON.stringify({
			type: "message_sent",
			message_id: messageId,
		}));
	}

	// Broadcast helpers
	broadcastToRoom(roomId: string, message: WSMessage) {
		const roomMembers = this.ctx.storage.sql.exec(`
			SELECT user_id FROM room_members WHERE room_id = '${roomId}'
		`).toArray() as { user_id: string }[];
		const memberIds = new Set(roomMembers.map((m) => m.user_id));

		let sentCount = 0;
		let botCount = 0;

		const connections = this.ctx.getWebSockets();

		for (const connection of connections) {
			const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
			if (!attachment) {
				continue;
			}

			if (attachment.type === "user") {
				// Send to all room members
				if (memberIds.has(attachment.userId)) {
					connection.send(JSON.stringify(message));
					sentCount++;
				}
			} else if (attachment.type === "bot") {
				botCount++;
				// Broadcast user messages from any room to bot
				if (message.type === "new_message") {
					const newMessage = message as Extract<WSMessage, { type: "new_message" }>;

					if (newMessage.message.source === "user") {
						// Plugin-compatible format: { type: "message", message: { room_id, user_id, content, timestamp } }
						const pluginMessage = {
							type: "message",
							message: {
								room_id: roomId,
								user_id: newMessage.message.user_id,
								content: newMessage.message.content,
								timestamp: newMessage.message.created_at,
							},
						};
						connection.send(JSON.stringify(pluginMessage));
						sentCount++;
					}
				}
			}
		}
	}

	broadcastUserStatus(userId: string, status: "online" | "offline") {
		const message: WSMessage = status === "online"
			? { type: "user_online", user_id: userId }
			: { type: "user_offline", user_id: userId };

		for (const connection of this.ctx.getWebSockets()) {
			const attachment = connection.deserializeAttachment() as ConnectionAttachment | null;
			if (attachment?.type === "user" && attachment.userId !== userId) {
				connection.send(JSON.stringify(message));
			}
		}
	}
}

// Worker entry point
export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;

		// WebSocket connections
		if (path.startsWith("/parties/") || path === "/ws/bot") {
			try {
				const id = env.ChatV2.idFromName("ChatV2");
				const stub = env.ChatV2.get(id);

				const newRequest = new Request(request, {
					headers: {
						...Object.fromEntries(request.headers.entries()),
						"X-PartyKit-Server": "ChatV2",
						"X-PartyKit-Room": "ChatV2",
					},
				});

				return await stub.fetch(newRequest);
			} catch (error) {
				return new Response(
					JSON.stringify({
						success: false,
						error: error instanceof Error ? error.message : "Unknown error",
					} as APIResponse),
					{ status: 500, headers: { "Content-Type": "application/json" } }
				);
			}
		}

		// API requests
		if (path.startsWith("/api/")) {
			try {
				const id = env.ChatV2.idFromName("ChatV2");
				const stub = env.ChatV2.get(id);

				const newRequest = new Request(request, {
					headers: {
						...Object.fromEntries(request.headers.entries()),
						"X-PartyKit-Server": "ChatV2",
						"X-PartyKit-Room": "ChatV2",
					},
				});

				return await stub.fetch(newRequest);
			} catch (error) {
				return new Response(
					JSON.stringify({
						success: false,
						error: error instanceof Error ? error.message : "Unknown error",
					} as APIResponse),
					{ status: 500, headers: { "Content-Type": "application/json" } }
				);
			}
		}

		// Static assets
		return (await routePartykitRequest(request, { ...env })) || env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
