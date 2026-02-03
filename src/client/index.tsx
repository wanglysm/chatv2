import { createRoot } from "react-dom/client";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router";
import { useWebSocket } from "./hooks/useWebSocket";
import type { User, Room, Message, Session, WSMessage, APIResponse, MessageContent } from "../shared";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { chatDB } from "./db";

// Parse message content
function parseMessageContent(message: Message): MessageContent {
	if (!message.content_type || message.content_type === "text") {
		try {
			return JSON.parse(message.content);
		} catch {
			return { type: "text", text: message.content };
		}
	}
	return JSON.parse(message.content);
}

// Message content renderer component
function MessageContentRenderer({ message }: { message: Message }) {
	const content = parseMessageContent(message);

	switch (content.type) {
		case "text":
			return (
				<div
					className="message-text markdown-content"
					dangerouslySetInnerHTML={{
						__html: DOMPurify.sanitize(marked.parse(content.text) as string),
					}}
				/>
			);

		case "image":
			return (
				<div className="message-image">
					<img
						src={`data:${content.mime_type};base64,${content.data}`}
						alt={content.name || "图片"}
						style={{ maxWidth: "300px", borderRadius: "8px", cursor: "pointer" }}
						onClick={() => window.open(`data:${content.mime_type};base64,${content.data}`, "_blank")}
					/>
				</div>
			);

		case "audio":
			return (
				<div className="message-audio">
					<audio controls src={`data:${content.mime_type};base64,${content.data}`} />
				</div>
			);

		case "video":
			return (
				<div className="message-video">
					<video
						controls
						src={`data:${content.mime_type};base64,${content.data}`}
						style={{ maxWidth: "300px", borderRadius: "8px" }}
					/>
				</div>
			);

		case "location":
			return (
				<div className="message-location">
					📍 {content.address || `${content.latitude.toFixed(6)}, ${content.longitude.toFixed(6)}`}
				</div>
			);

		case "card":
			return (
				<div className="message-card">
					<div className="card-title">{content.title}</div>
					{content.description && <div className="card-desc">{content.description}</div>}
					{content.url && (
						<a href={content.url} target="_blank" rel="noopener noreferrer">
							查看详情 →
						</a>
					)}
				</div>
			);

		case "file":
			return (
				<div className="message-file">
					📎 {content.name || "文件"}
				</div>
			);

		default:
			return <div className="message-text">{message.content}</div>;
	}
}

// Connection status indicator component
function ConnectionStatus({ state, reconnectAttempt }: { state: string; reconnectAttempt: number }) {
	const getStatusColor = () => {
		switch (state) {
			case "connected":
				return "#4caf50";
			case "connecting":
			case "reconnecting":
				return "#ff9800";
			case "disconnected":
				return "#f44336";
			default:
				return "#9e9e9e";
		}
	};

	const getStatusText = () => {
		switch (state) {
			case "connected":
				return "在线";
			case "connecting":
				return "连接中...";
			case "reconnecting":
				return `重连中 (${reconnectAttempt})...`;
			case "disconnected":
				return "离线";
			default:
				return "未知";
		}
	};

	return (
		<div className="connection-status" style={{ color: getStatusColor() }}>
			<span className="status-dot" style={{ backgroundColor: getStatusColor() }}></span>
			{getStatusText()}
		</div>
	);
}

// Login Page
function LoginPage() {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const navigate = useNavigate();

	const handleLogin = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		try {
			const response = await fetch("/api/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, password }),
		});

		const data = (await response.json()) as APIResponse<{ session: Session; user: User }>;

			if (data.success && data.data) {
			localStorage.setItem("session", JSON.stringify(data.data.session));
			localStorage.setItem("user", JSON.stringify(data.data.user));
			navigate("/chat");
		} else {
			setError(data.error || "登录失败");
		}
		} catch (err) {
			setError("网络错误，请重试");
		}
	};

	return (
		<div className="login-container">
			<div className="login-box">
				<h1>登录 ChatV2</h1>
				<form onSubmit={handleLogin}>
					<div className="form-group">
						<label>用户名</label>
						<input
							type="text"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							placeholder="请输入用户名"
							required
						/>
					</div>
					<div className="form-group">
						<label>密码</label>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							placeholder="请输入密码"
							required
						/>
					</div>
					{error && <div className="error-message">{error}</div>}
					<button type="submit" className="login-button">
						登录
					</button>
				</form>
				<div className="login-hint">
					<p>默认管理员账号：admin / admin123</p>
				</div>
			</div>
		</div>
	);
}

// Chat Page
function ChatPage() {
	const [session, setSession] = useState<Session | null>(null);
	const [currentUser, setCurrentUser] = useState<User | null>(null);
	const [rooms, setRooms] = useState<Room[]>([]);
	const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [users, setUsers] = useState<User[]>([]);
	const [messageInput, setMessageInput] = useState("");
	const [unreadCounts, setUnreadCounts] = useState<Map<string, number>>(new Map());
	const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
	const [showCreateUser, setShowCreateUser] = useState(false);
	const [showUserList, setShowUserList] = useState(false);
	const [showChangePassword, setShowChangePassword] = useState(false);
	const [showChangeNickname, setShowChangeNickname] = useState(false);
	const [showUserMenu, setShowUserMenu] = useState(false);

	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const userMenuRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const navigate = useNavigate();
	const originalTitleRef = useRef<string>("ChatV2");

	// Load session and user
	useEffect(() => {
		const sessionData = localStorage.getItem("session");
		const userData = localStorage.getItem("user");

		if (!sessionData || !userData) {
			navigate("/login");
			return;
		}

		setSession(JSON.parse(sessionData));
		setCurrentUser(JSON.parse(userData));
	}, [navigate]);

	// Track pending acknowledgments - messages that need to be acked when room is opened
	const pendingAcksRef = useRef<Set<string>>(new Set());

	// Handle incoming WebSocket messages
	const handleWebSocketMessage = useCallback((message: WSMessage) => {
		switch (message.type) {
			case "new_message": {
				// Use functional update to check if room exists and add it if not
				setRooms((prevRooms) => {
					const roomExists = prevRooms.some((r) => r.id === message.message.room_id);
					if (!roomExists) {
						// Create a new room object from the message info
						const newRoom: Room = {
							id: message.message.room_id,
							name: message.user.nickname || message.user.username,
							type: "private",
							created_at: Date.now(),
						};
						return [newRoom, ...prevRooms];
					}
					return prevRooms;
				});

				// Save message to local IndexedDB
			chatDB.addMessage(message.message.room_id, message.message, message.user).catch(() => {
				// Ignore IndexedDB errors
			});

				if (selectedRoom?.id === message.message.room_id) {
					// User is viewing this room, send ack immediately (but not for own messages)
					if (message.message.user_id !== currentUser?.id) {
						ackMessage(message.message.id, "delivered");
					}

					setMessages((prev) => {
						// Check if message already exists (including temp messages from current user)
						const existingIndex = prev.findIndex((m) => m.id === message.message.id);
						if (existingIndex !== -1) {
							return prev;
						}
						// Check if there's a temp message from the same user with similar content
						const tempIndex = prev.findIndex(
							(m) =>
								m.id.startsWith("temp-") &&
								m.user_id === message.message.user_id &&
								m.content === message.message.content
						);
						if (tempIndex !== -1) {
							// Replace temp message with real message
							const newMessages = [...prev];
							newMessages[tempIndex] = message.message;
							return newMessages;
						}
						return [...prev, message.message];
					});
					// Add user if not exists
					setUsers((prev) => {
						if (prev.some((u) => u.id === message.user.id)) {
							return prev;
						}
						return [...prev, message.user];
					});
				} else {
					// User is not viewing this room, add to pending acks
					if (message.message.user_id !== currentUser?.id) {
						pendingAcksRef.current.add(message.message.id);
						setUnreadCounts((prev) => {
							const newMap = new Map(prev);
							newMap.set(message.message.room_id, (newMap.get(message.message.room_id) || 0) + 1);
							return newMap;
						});
					}
				}
				break;
			}

			case "room_messages":
				if (selectedRoom?.id === message.room_id) {
					setMessages(message.messages);
					setUsers(message.users);
					// Save to local IndexedDB
					chatDB.saveRoomData(message.room_id, message.messages, message.users);
				}
				break;

			case "sync_response":
				// Merge sync messages with existing
				setMessages((prev) => {
					const existingIds = new Set(prev.map((m) => m.id));
					const newMessages = message.messages.filter((m) => !existingIds.has(m.id));
					return [...prev, ...newMessages].sort((a, b) => a.created_at - b.created_at);
				});
				setUsers((prev) => {
					const existingIds = new Set(prev.map((u) => u.id));
					const newUsers = message.users.filter((u) => !existingIds.has(u.id));
					return [...prev, ...newUsers];
				});
				// Save synced messages to local IndexedDB
				if (selectedRoom && message.messages.length > 0) {
					chatDB.saveRoomData(selectedRoom.id, message.messages, message.users);
				}
				break;

			case "user_online":
				setOnlineUsers((prev) => new Set([...prev, message.user_id]));
				break;

			case "user_offline":
				setOnlineUsers((prev) => {
					const newSet = new Set(prev);
					newSet.delete(message.user_id);
					return newSet;
				});
				break;
		}
	}, [selectedRoom, currentUser]);

	// WebSocket hook
	const { connectionState, reconnectAttempt, joinRoom, leaveRoom, syncMessages, ackMessage } = useWebSocket({
		sessionId: session?.id || null,
		onMessage: handleWebSocketMessage,
		onConnect: () => {
			// Sync messages after reconnection
			const lastMessage = messages[messages.length - 1];
			syncMessages(lastMessage?.id);
		},
	});

	// Load rooms
	const loadRooms = async () => {
		try {
			const sessionData = localStorage.getItem("session");
			if (!sessionData) return;

			const session = JSON.parse(sessionData);
			const response = await fetch("/api/rooms", {
				headers: { Authorization: `Bearer ${session.id}` },
			});

			const data = (await response.json()) as APIResponse<Room[]>;
			if (data.success && data.data) {
				setRooms(data.data);
			}
		} catch {
			// Ignore load rooms error
		}
	};

	// Initial load
	useEffect(() => {
		if (session) {
			loadRooms();
		}
	}, [session]);

	// Update page title with unread count
	useEffect(() => {
		const totalUnread = Array.from(unreadCounts.values()).reduce((sum, count) => sum + count, 0);
		if (totalUnread > 0) {
			document.title = `(${totalUnread}) ChatV2`;
		} else {
			document.title = originalTitleRef.current;
		}
	}, [unreadCounts]);

	// Handle room selection
	const handleSelectRoom = (room: Room) => {
		if (selectedRoom) {
			leaveRoom(selectedRoom.id);
		}

		setSelectedRoom(room);
		setUnreadCounts((prev) => {
			const newMap = new Map(prev);
			newMap.delete(room.id);
			return newMap;
		});

		// Load messages via HTTP first
		loadRoomMessages(room.id);

		// Join room via WebSocket
		joinRoom(room.id);
	};

	// Track loading state to prevent duplicate calls
	const loadingRoomsRef = useRef<Set<string>>(new Set());

	const loadRoomMessages = async (roomId: string) => {
		// Prevent duplicate calls for the same room
		if (loadingRoomsRef.current.has(roomId)) {
			return;
		}
		loadingRoomsRef.current.add(roomId);

		try {
			// First, try to load from local IndexedDB for instant display
			const localData = await chatDB.getRoomData(roomId);
			if (localData) {
				setMessages(localData.messages);
				setUsers(localData.users);
			}

			// Then fetch from server to get new messages
			const response = await fetch(`/api/rooms/${roomId}`, {
				headers: { Authorization: `Bearer ${session?.id}` },
			});
			const data = (await response.json()) as APIResponse<{ messages: Message[]; users: User[] }>;
			if (data.success && data.data) {
				// Merge server messages with local messages
				// Server may have deleted some messages, but local still has them
				const localMsgs = localData?.messages || [];
				const serverMsgs = data.data.messages;
				
				// Create a map of all messages by ID
				const messageMap = new Map<string, Message>();
				localMsgs.forEach(msg => messageMap.set(msg.id, msg));
				serverMsgs.forEach(msg => messageMap.set(msg.id, msg));
				
				// Convert back to array and sort by time
				const mergedMessages = Array.from(messageMap.values()).sort((a, b) => a.created_at - b.created_at);
				
				// Merge users
				const localUsers = localData?.users || [];
				const serverUsers = data.data.users;
				const userMap = new Map<string, User>();
				localUsers.forEach(u => userMap.set(u.id, u));
				serverUsers.forEach(u => userMap.set(u.id, u));
				const mergedUsers = Array.from(userMap.values());
				
				setMessages(mergedMessages);
				setUsers(mergedUsers);
				
				// Save merged data to local IndexedDB
				await chatDB.saveRoomData(roomId, mergedMessages, mergedUsers);

				// After messages are fully loaded and saved, send pending acknowledgments
				// This ensures large files are completely received before server deletes them
				serverMsgs.forEach(msg => {
					// Only ack messages from others, not own messages
					if (msg.user_id !== currentUser?.id && pendingAcksRef.current.has(msg.id)) {
						ackMessage(msg.id, "delivered");
						pendingAcksRef.current.delete(msg.id);
					}
				});
			}
		} catch {
			// Ignore load messages error
		} finally {
			loadingRoomsRef.current.delete(roomId);
		}
	};

	// Send text message
	const handleSendMessage = async () => {
		if (!messageInput.trim() || !selectedRoom || !currentUser) return;

		const contentObj = { type: "text" as const, text: messageInput };
		const tempMessage: Message = {
			id: `temp-${Date.now()}`,
			room_id: selectedRoom.id,
			user_id: currentUser.id,
			content: JSON.stringify(contentObj),
			content_type: "text",
			created_at: Date.now(),
		};

		setMessages((prev) => [...prev, tempMessage]);
		setMessageInput("");

		try {
			const response = await fetch("/api/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${session?.id}`,
				},
				body: JSON.stringify({
					room_id: selectedRoom.id,
					content: JSON.stringify(contentObj),
					content_type: "text",
				}),
			});

			const data = (await response.json()) as APIResponse<{ message_id: string }>;
			if (!data.success) {
				// Remove temp message on failure
				setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
				setMessageInput(messageInput);
			}
		} catch {
			setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
			setMessageInput(messageInput);
		}
	};

	// Handle file select
	const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file || !selectedRoom || !currentUser) return;

		// Check file size (max 500KB to avoid SQLITE_TOOBIG after base64 encoding)
		// Base64 increases size by ~33%, so 500KB -> ~670KB
		if (file.size > 500 * 1024) {
			alert("文件大小不能超过 500KB");
			return;
		}

		const reader = new FileReader();
		reader.onload = async () => {
			const base64 = (reader.result as string).split(",")[1];
			const mimeType = file.type;

			let contentType: "image" | "audio" | "video" | "file" = "file";
			if (mimeType.startsWith("image/")) contentType = "image";
			else if (mimeType.startsWith("audio/")) contentType = "audio";
			else if (mimeType.startsWith("video/")) contentType = "video";

			const contentObj = {
				type: contentType,
				data: base64,
				mime_type: mimeType,
				name: file.name,
			};

			const tempMessage: Message = {
				id: `temp-${Date.now()}`,
				room_id: selectedRoom.id,
				user_id: currentUser.id,
				content: JSON.stringify(contentObj),
				content_type: contentType,
				created_at: Date.now(),
			};

			setMessages((prev) => [...prev, tempMessage]);

			try {
				const response = await fetch("/api/messages", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${session?.id}`,
					},
					body: JSON.stringify({
						room_id: selectedRoom.id,
						content: JSON.stringify(contentObj),
						content_type: contentType,
					}),
				});

				const data = (await response.json()) as APIResponse<{ message_id: string }>;
				if (!data.success) {
					setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
					alert("发送文件失败: " + data.error);
				}
			} catch {
				setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
				alert("发送文件失败");
			}
		};

		reader.readAsDataURL(file);
		// Reset file input
		e.target.value = "";
	};

	// Scroll to bottom when messages change
	useEffect(() => {
		if (messagesContainerRef.current) {
			messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
		}
	}, [messages]);

	// Handle click outside user menu
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
				setShowUserMenu(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	const handleLogout = () => {
		localStorage.removeItem("session");
		localStorage.removeItem("user");
		navigate("/login");
	};

	const handleCreateBotRoom = async () => {
		if (!currentUser) return;

		try {
			const response = await fetch("/api/rooms", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${session?.id}`,
				},
				body: JSON.stringify({
					name: "AI助手",
					type: "bot",
					member_ids: [currentUser.id],
				}),
			});

			const data = (await response.json()) as APIResponse<Room>;
			if (data.success) {
				loadRooms();
		}
	} catch {
			// Ignore create bot room error
		}
	};

	const handleDeleteRoom = async (roomId: string, roomType: string, e: React.MouseEvent) => {
		e.stopPropagation();

		if (!confirm("确定要删除这个聊天室吗？")) return;

		try {
			const response = await fetch(`/api/rooms/${roomId}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${session?.id}` },
			});

			const data = (await response.json()) as APIResponse;
			if (data.success) {
				if (selectedRoom?.id === roomId) {
					setSelectedRoom(null);
					setMessages([]);
				}
				loadRooms();
			}
		} catch {
			// Ignore delete room error
		}
	};

	const handleUserSelected = async (targetUserId: string) => {
		setShowUserList(false);
		if (!currentUser) return;

		try {
			const response = await fetch("/api/rooms", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${session?.id}`,
				},
				body: JSON.stringify({
					name: "Private Chat",
					type: "private",
					member_ids: [currentUser.id, targetUserId],
				}),
			});

			const data = (await response.json()) as APIResponse<Room>;
			if (data.success) {
				await loadRooms();
				if (data.data) {
					handleSelectRoom(data.data);
				}
		}
	} catch {
			// Ignore create chat error
		}
	};

	const getUserById = (userId: string): User | undefined => {
		return users.find((u) => u.id === userId);
	};

	const getDisplayName = (user: User | undefined): string => {
		return user?.nickname || user?.username || "未知用户";
	};

	// Delete message
	const handleDeleteMessage = async (messageId: string) => {
		if (!confirm("确定要删除这条消息吗？")) return;

		try {
			const response = await fetch(`/api/messages/${messageId}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${session?.id}` },
			});

			const data = (await response.json()) as APIResponse;
			if (data.success) {
				// Remove from local state
				setMessages((prev) => prev.filter((m) => m.id !== messageId));
				// Remove from IndexedDB
				if (selectedRoom) {
					chatDB.addMessage(selectedRoom.id, { id: messageId } as Message, {} as User).catch(() => {
						// Ignore error
					});
				}
			} else {
				alert("删除失败: " + data.error);
			}
		} catch {
			alert("删除失败，请重试");
		}
	};

	const formatTime = (timestamp: number) => {
		const date = new Date(timestamp);
		return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
	};

	if (!session || !currentUser) {
		return <div>加载中...</div>;
	}

	return (
		<div className="chat-container">
			<div className="sidebar">
				<div className="user-info" ref={userMenuRef}>
					<div className="user-info-main" onClick={() => setShowUserMenu(!showUserMenu)}>
						<div className="avatar">{currentUser.avatar || "👤"}</div>
						<div className="username">
							{currentUser.nickname
								? `${currentUser.username} (${currentUser.nickname})`
								: currentUser.username}
						</div>
						<ConnectionStatus state={connectionState} reconnectAttempt={reconnectAttempt} />
						<div className="menu-arrow">{showUserMenu ? "▲" : "▼"}</div>
					</div>
					{showUserMenu && (
						<div className="user-menu-dropdown">
							{currentUser.role === "admin" && (
								<button onClick={() => { setShowCreateUser(true); setShowUserMenu(false); }}>
									<span>👤</span> 创建用户
								</button>
								)}
							<button onClick={() => { setShowChangeNickname(true); setShowUserMenu(false); }}>
								<span>✏️</span> 修改昵称
							</button>
							<button onClick={() => { setShowChangePassword(true); setShowUserMenu(false); }}>
								<span>🔒</span> 修改密码
							</button>
							<div className="menu-divider"></div>
							<button onClick={() => { handleLogout(); setShowUserMenu(false); }} className="logout-item">
								<span>🚪</span> 退出登录
							</button>
						</div>
					)}
				</div>

				<div className="room-list">
					<div className="room-list-header">
						<span>聊天</span>
						<div className="room-actions">
							<button onClick={() => setShowUserList(true)} className="add-room-button" title="新聊天">
								+
							</button>
							<button onClick={handleCreateBotRoom} className="add-room-button" title="AI助手">
								🤖
							</button>
						</div>
					</div>
					{rooms.map((room) => (
						<div
							key={room.id}
							className={`room-item ${selectedRoom?.id === room.id ? "active" : ""}`}
							onClick={() => handleSelectRoom(room)}
						>
							<div className="room-avatar">
								{room.avatar || (room.type === "bot" ? "🤖" : "💬")}
							</div>
							<div className="room-info">
								<div className="room-name">{room.name}</div>
								<div className="room-type">
									{room.type === "bot" ? "AI助手" : room.type === "group" ? "群聊" : "私聊"}
								</div>
							</div>
							{unreadCounts.get(room.id) ? (
								<div className="unread-badge">{unreadCounts.get(room.id)}</div>
							) : null}
								<button
								onClick={(e) => handleDeleteRoom(room.id, room.type, e)}
								className="delete-room-button"
								title="删除聊天"
							>
								×
							</button>
						</div>
					))}
				</div>
			</div>

			<div className="chat-area">
				{selectedRoom ? (
					<>
						<div className="chat-header">
							<div className="chat-title">
								<span className="chat-avatar">
									{selectedRoom.avatar || (selectedRoom.type === "bot" ? "🤖" : "💬")}
								</span>
								<span className="chat-name">{selectedRoom.name}</span>
							</div>
						</div>
						<div className="messages-container" ref={messagesContainerRef}>
							{messages.map((message) => {
							const user = getUserById(message.user_id);
							const isOwnMessage = message.user_id === currentUser.id;
							return (
								<div key={message.id} className={`message ${isOwnMessage ? "own" : "other"}`}>
									{!isOwnMessage && (
										<div className="message-avatar">{user?.avatar || "👤"}</div>
									)}
									<div className="message-content">
										{isOwnMessage && (
											<button
												className="message-delete-button"
												onClick={() => handleDeleteMessage(message.id)}
												title="删除消息"
											>
												×
											</button>
										)}
										{!isOwnMessage && (
											<div className="message-sender">{getDisplayName(user)}</div>
										)}
										<MessageContentRenderer message={message} />
										<div className="message-time">{formatTime(message.created_at)}</div>
									</div>
								</div>
							);
							})}
							</div>
							<div className="input-area">
								<input
									type="file"
									ref={fileInputRef}
									style={{ display: "none" }}
									onChange={handleFileSelect}
									accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt"
								/>
								<button
									onClick={() => fileInputRef.current?.click()}
									className="attach-button"
									disabled={connectionState !== "connected"}
									title="发送文件"
								>
									📎
								</button>
								<input
									type="text"
									className="message-input"
									placeholder="输入消息..."
									value={messageInput}
									onChange={(e) => setMessageInput(e.target.value)}
									onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
									disabled={connectionState !== "connected"}
								/>
								<button onClick={handleSendMessage} className="send-button" disabled={connectionState !== "connected"}>
									发送
								</button>
							</div>
						</>
					) : (
						<div className="empty-state">
							<div className="empty-icon">💬</div>
							<div className="empty-text">选择一个聊天开始对话</div>
						</div>
					)}
				</div>

			{showCreateUser && <CreateUserModal onClose={() => setShowCreateUser(false)} />}
			{showUserList && <UserListModal onClose={() => setShowUserList(false)} onUserSelected={handleUserSelected} />}
			{showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
			{showChangeNickname && (
				<ChangeNicknameModal
					onClose={() => setShowChangeNickname(false)}
					currentNickname={currentUser?.nickname}
					onNicknameChanged={(nickname) => {
						if (currentUser) {
							const updatedUser = { ...currentUser, nickname };
							setCurrentUser(updatedUser);
							localStorage.setItem("user", JSON.stringify(updatedUser));
						}
					}}
				/>
			)}
		</div>
	);
}

// Modals
function CreateUserModal({ onClose }: { onClose: () => void }) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [success, setSuccess] = useState(false);

	const handleCreate = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (username.length < 3) {
			setError("用户名至少3位");
			return;
		}
		if (password.length < 6) {
			setError("密码至少6位");
			return;
		}

		try {
			const session = JSON.parse(localStorage.getItem("session") || "{}");
			const response = await fetch("/api/users", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${session.id}`,
				},
				body: JSON.stringify({ username, password }),
			});

			const data = (await response.json()) as APIResponse<User>;
			if (data.success) {
				setSuccess(true);
				setTimeout(onClose, 1500);
			} else {
				setError(data.error || "创建失败");
			}
		} catch {
			setError("网络错误");
		}
	};

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-content" onClick={(e) => e.stopPropagation()}>
				<h2>创建用户</h2>
				{success ? (
					<div className="success-message">创建成功！</div>
				) : (
					<form onSubmit={handleCreate}>
						<div className="form-group">
							<label>用户名</label>
							<input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
						</div>
						<div className="form-group">
							<label>密码</label>
							<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
						</div>
						{error && <div className="error-message">{error}</div>}
						<div className="modal-buttons">
							<button type="button" onClick={onClose}>取消</button>
							<button type="submit">创建</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}

function UserListModal({ onClose, onUserSelected }: { onClose: () => void; onUserSelected: (userId: string) => void }) {
	const [users, setUsers] = useState<User[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const fetchUsers = async () => {
			try {
				const session = JSON.parse(localStorage.getItem("session") || "{}");
				const response = await fetch("/api/users", {
					headers: { Authorization: `Bearer ${session.id}` },
				});
				const data = (await response.json()) as APIResponse<User[]>;
			if (data.success && data.data) {
				setUsers(data.data);
			}
			} catch {
			// Ignore load users error
		} finally {
				setLoading(false);
			}
		};
		fetchUsers();
	}, []);

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-content" onClick={(e) => e.stopPropagation()}>
				<h2>发起新聊天</h2>
				{loading ? (
					<div>加载中...</div>
				) : (
					<div className="user-list">
						{users.length === 0 ? (
							<div className="empty-message">没有其他用户</div>
						) : (
							users.map((user) => (
								<div key={user.id} className="user-list-item" onClick={() => onUserSelected(user.id)}>
									<div className="avatar">{user.avatar || "👤"}</div>
									<div className="user-info">
										<div className="username">{user.nickname || user.username}</div>
									</div>
								</div>
								))
							)}
						</div>
					)}
					<div className="modal-buttons">
						<button onClick={onClose}>取消</button>
					</div>
				</div>
			</div>
		);
	}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
	const [oldPassword, setOldPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [error, setError] = useState("");
	const [success, setSuccess] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (newPassword !== confirmPassword) {
			setError("密码不匹配");
			return;
		}
		if (newPassword.length < 6) {
			setError("密码至少6位");
			return;
		}

		try {
			const session = JSON.parse(localStorage.getItem("session") || "{}");
			const response = await fetch("/api/change-password", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${session.id}`,
				},
				body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
			});

			const data = (await response.json()) as APIResponse;
			if (data.success) {
				setSuccess(true);
				setTimeout(onClose, 1500);
			} else {
				setError(data.error || "修改失败");
			}
		} catch {
			setError("网络错误");
		}
	};

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-content" onClick={(e) => e.stopPropagation()}>
				<h2>修改密码</h2>
				{success ? (
					<div className="success-message">修改成功！</div>
				) : (
					<form onSubmit={handleSubmit}>
						<div className="form-group">
							<label>旧密码</label>
							<input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required />
						</div>
						<div className="form-group">
							<label>新密码</label>
							<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
						</div>
						<div className="form-group">
							<label>确认新密码</label>
							<input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
						</div>
						{error && <div className="error-message">{error}</div>}
						<div className="modal-buttons">
							<button type="button" onClick={onClose}>取消</button>
							<button type="submit">确认</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}

function ChangeNicknameModal({
	onClose,
	currentNickname,
	onNicknameChanged,
}: {
	onClose: () => void;
	currentNickname?: string;
	onNicknameChanged?: (nickname: string) => void;
}) {
	const [nickname, setNickname] = useState(currentNickname || "");
	const [error, setError] = useState("");
	const [success, setSuccess] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (nickname.length < 1) {
			setError("昵称不能为空");
			return;
		}
		if (nickname.length > 20) {
			setError("昵称不能超过20字符");
			return;
		}

		try {
			const session = JSON.parse(localStorage.getItem("session") || "{}");
			const response = await fetch("/api/change-nickname", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${session.id}`,
				},
				body: JSON.stringify({ nickname }),
			});

			const data = (await response.json()) as APIResponse;
			if (data.success) {
				setSuccess(true);
				onNicknameChanged?.(nickname);
				setTimeout(onClose, 1500);
			} else {
				setError(data.error || "修改失败");
			}
		} catch {
			setError("网络错误");
		}
	};

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-content" onClick={(e) => e.stopPropagation()}>
				<h2>修改昵称</h2>
				{success ? (
					<div className="success-message">修改成功！</div>
				) : (
					<form onSubmit={handleSubmit}>
						<div className="form-group">
							<label>昵称</label>
							<input
								type="text"
								value={nickname}
								onChange={(e) => setNickname(e.target.value)}
								placeholder="1-20字符"
								maxLength={20}
								required
							/>
						</div>
						{error && <div className="error-message">{error}</div>}
						<div className="modal-buttons">
							<button type="button" onClick={onClose}>取消</button>
							<button type="submit">确认</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}

// App
function App() {
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<Navigate to="/login" />} />
				<Route path="/login" element={<LoginPage />} />
				<Route path="/chat" element={<ChatPage />} />
				<Route path="*" element={<Navigate to="/login" />} />
			</Routes>
		</BrowserRouter>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
