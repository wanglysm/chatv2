import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { useState, useEffect, useRef, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router";
import { useWebSocket } from "./hooks/useWebSocket";
import { marked } from "marked";
import DOMPurify from "dompurify";
// Parse message content
function parseMessageContent(message) {
    if (!message.content_type || message.content_type === "text") {
        try {
            return JSON.parse(message.content);
        }
        catch {
            return { type: "text", text: message.content };
        }
    }
    return JSON.parse(message.content);
}
// Message content renderer component
function MessageContentRenderer({ message }) {
    const content = parseMessageContent(message);
    switch (content.type) {
        case "text":
            return (_jsx("div", { className: "message-text markdown-content", dangerouslySetInnerHTML: {
                    __html: DOMPurify.sanitize(marked.parse(content.text)),
                } }));
        case "image":
            return (_jsx("div", { className: "message-image", children: _jsx("img", { src: `data:${content.mime_type};base64,${content.data}`, alt: content.name || "图片", style: { maxWidth: "300px", borderRadius: "8px", cursor: "pointer" }, onClick: () => window.open(`data:${content.mime_type};base64,${content.data}`, "_blank") }) }));
        case "audio":
            return (_jsx("div", { className: "message-audio", children: _jsx("audio", { controls: true, src: `data:${content.mime_type};base64,${content.data}` }) }));
        case "video":
            return (_jsx("div", { className: "message-video", children: _jsx("video", { controls: true, src: `data:${content.mime_type};base64,${content.data}`, style: { maxWidth: "300px", borderRadius: "8px" } }) }));
        case "location":
            return (_jsxs("div", { className: "message-location", children: ["\uD83D\uDCCD ", content.address || `${content.latitude.toFixed(6)}, ${content.longitude.toFixed(6)}`] }));
        case "card":
            return (_jsxs("div", { className: "message-card", children: [_jsx("div", { className: "card-title", children: content.title }), content.description && _jsx("div", { className: "card-desc", children: content.description }), content.url && (_jsx("a", { href: content.url, target: "_blank", rel: "noopener noreferrer", children: "\u67E5\u770B\u8BE6\u60C5 \u2192" }))] }));
        case "file":
            return (_jsxs("div", { className: "message-file", children: ["\uD83D\uDCCE ", content.name || "文件"] }));
        default:
            return _jsx("div", { className: "message-text", children: message.content });
    }
}
// Connection status indicator component
function ConnectionStatus({ state, reconnectAttempt }) {
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
    return (_jsxs("div", { className: "connection-status", style: { color: getStatusColor() }, children: [_jsx("span", { className: "status-dot", style: { backgroundColor: getStatusColor() } }), getStatusText()] }));
}
// Login Page
function LoginPage() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const navigate = useNavigate();
    const handleLogin = async (e) => {
        e.preventDefault();
        setError("");
        try {
            const response = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
            });
            const data = (await response.json());
            if (data.success && data.data) {
                localStorage.setItem("session", JSON.stringify(data.data.session));
                localStorage.setItem("user", JSON.stringify(data.data.user));
                navigate("/chat");
            }
            else {
                setError(data.error || "登录失败");
            }
        }
        catch (err) {
            setError("网络错误，请重试");
        }
    };
    return (_jsx("div", { className: "login-container", children: _jsxs("div", { className: "login-box", children: [_jsx("h1", { children: "\u767B\u5F55 ChatV2" }), _jsxs("form", { onSubmit: handleLogin, children: [_jsxs("div", { className: "form-group", children: [_jsx("label", { children: "\u7528\u6237\u540D" }), _jsx("input", { type: "text", value: username, onChange: (e) => setUsername(e.target.value), placeholder: "\u8BF7\u8F93\u5165\u7528\u6237\u540D", required: true })] }), _jsxs("div", { className: "form-group", children: [_jsx("label", { children: "\u5BC6\u7801" }), _jsx("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "\u8BF7\u8F93\u5165\u5BC6\u7801", required: true })] }), error && _jsx("div", { className: "error-message", children: error }), _jsx("button", { type: "submit", className: "login-button", children: "\u767B\u5F55" })] }), _jsx("div", { className: "login-hint", children: _jsx("p", { children: "\u9ED8\u8BA4\u7BA1\u7406\u5458\u8D26\u53F7\uFF1Aadmin / admin123" }) })] }) }));
}
// Chat Page
function ChatPage() {
    const [session, setSession] = useState(null);
    const [currentUser, setCurrentUser] = useState(null);
    const [rooms, setRooms] = useState([]);
    const [selectedRoom, setSelectedRoom] = useState(null);
    const [messages, setMessages] = useState([]);
    const [users, setUsers] = useState([]);
    const [messageInput, setMessageInput] = useState("");
    const [unreadCounts, setUnreadCounts] = useState(new Map());
    const [onlineUsers, setOnlineUsers] = useState(new Set());
    const [showCreateUser, setShowCreateUser] = useState(false);
    const [showUserList, setShowUserList] = useState(false);
    const [showChangePassword, setShowChangePassword] = useState(false);
    const [showChangeNickname, setShowChangeNickname] = useState(false);
    const [showUserMenu, setShowUserMenu] = useState(false);
    const messagesContainerRef = useRef(null);
    const userMenuRef = useRef(null);
    const fileInputRef = useRef(null);
    const navigate = useNavigate();
    const originalTitleRef = useRef("ChatV2");
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
    // Handle incoming WebSocket messages
    const handleWebSocketMessage = useCallback((message) => {
        switch (message.type) {
            case "new_message": {
                // Use functional update to check if room exists and add it if not
                setRooms((prevRooms) => {
                    const roomExists = prevRooms.some((r) => r.id === message.message.room_id);
                    if (!roomExists) {
                        // Create a new room object from the message info
                        const newRoom = {
                            id: message.message.room_id,
                            name: message.user.nickname || message.user.username,
                            type: "private",
                            created_at: Date.now(),
                        };
                        return [newRoom, ...prevRooms];
                    }
                    return prevRooms;
                });
                if (selectedRoom?.id === message.message.room_id) {
                    setMessages((prev) => {
                        // Check if message already exists (including temp messages from current user)
                        const existingIndex = prev.findIndex((m) => m.id === message.message.id);
                        if (existingIndex !== -1) {
                            return prev;
                        }
                        // Check if there's a temp message from the same user with similar content
                        const tempIndex = prev.findIndex((m) => m.id.startsWith("temp-") &&
                            m.user_id === message.message.user_id &&
                            m.content === message.message.content);
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
                }
                else {
                    // Update unread count for other rooms (including new rooms)
                    if (message.message.user_id !== currentUser?.id) {
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
    const { connectionState, reconnectAttempt, joinRoom, leaveRoom, syncMessages } = useWebSocket({
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
            if (!sessionData)
                return;
            const session = JSON.parse(sessionData);
            const response = await fetch("/api/rooms", {
                headers: { Authorization: `Bearer ${session.id}` },
            });
            const data = (await response.json());
            if (data.success && data.data) {
                setRooms(data.data);
            }
        }
        catch {
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
        }
        else {
            document.title = originalTitleRef.current;
        }
    }, [unreadCounts]);
    // Handle room selection
    const handleSelectRoom = (room) => {
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
    const loadRoomMessages = async (roomId) => {
        try {
            const response = await fetch(`/api/rooms/${roomId}`, {
                headers: { Authorization: `Bearer ${session?.id}` },
            });
            const data = (await response.json());
            if (data.success && data.data) {
                setMessages(data.data.messages);
                setUsers(data.data.users);
            }
        }
        catch {
            // Ignore load messages error
        }
    };
    // Send text message
    const handleSendMessage = async () => {
        if (!messageInput.trim() || !selectedRoom || !currentUser)
            return;
        const contentObj = { type: "text", text: messageInput };
        const tempMessage = {
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
            const data = (await response.json());
            if (!data.success) {
                // Remove temp message on failure
                setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
                setMessageInput(messageInput);
            }
        }
        catch {
            setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
            setMessageInput(messageInput);
        }
    };
    // Handle file select
    const handleFileSelect = async (e) => {
        const file = e.target.files?.[0];
        if (!file || !selectedRoom || !currentUser)
            return;
        // Check file size (max 5MB)
        if (file.size > 5 * 1024 * 1024) {
            alert("文件大小不能超过 5MB");
            return;
        }
        const reader = new FileReader();
        reader.onload = async () => {
            const base64 = reader.result.split(",")[1];
            const mimeType = file.type;
            let contentType = "file";
            if (mimeType.startsWith("image/"))
                contentType = "image";
            else if (mimeType.startsWith("audio/"))
                contentType = "audio";
            else if (mimeType.startsWith("video/"))
                contentType = "video";
            const contentObj = {
                type: contentType,
                data: base64,
                mime_type: mimeType,
                name: file.name,
            };
            const tempMessage = {
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
                const data = (await response.json());
                if (!data.success) {
                    setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
                    alert("发送文件失败: " + data.error);
                }
            }
            catch {
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
        const handleClickOutside = (event) => {
            if (userMenuRef.current && !userMenuRef.current.contains(event.target)) {
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
        if (!currentUser)
            return;
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
            const data = (await response.json());
            if (data.success) {
                loadRooms();
            }
        }
        catch {
            // Ignore create bot room error
        }
    };
    const handleDeleteRoom = async (roomId, roomType, e) => {
        e.stopPropagation();
        if (roomType !== "bot")
            return;
        if (!confirm("确定要删除这个聊天室吗？"))
            return;
        try {
            const response = await fetch(`/api/rooms/${roomId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${session?.id}` },
            });
            const data = (await response.json());
            if (data.success) {
                if (selectedRoom?.id === roomId) {
                    setSelectedRoom(null);
                    setMessages([]);
                }
                loadRooms();
            }
        }
        catch {
            // Ignore delete room error
        }
    };
    const handleUserSelected = async (targetUserId) => {
        setShowUserList(false);
        if (!currentUser)
            return;
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
            const data = (await response.json());
            if (data.success) {
                await loadRooms();
                if (data.data) {
                    handleSelectRoom(data.data);
                }
            }
        }
        catch {
            // Ignore create chat error
        }
    };
    const getUserById = (userId) => {
        return users.find((u) => u.id === userId);
    };
    const getDisplayName = (user) => {
        return user?.nickname || user?.username || "未知用户";
    };
    const formatTime = (timestamp) => {
        const date = new Date(timestamp);
        return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    };
    if (!session || !currentUser) {
        return _jsx("div", { children: "\u52A0\u8F7D\u4E2D..." });
    }
    return (_jsxs("div", { className: "chat-container", children: [_jsxs("div", { className: "sidebar", children: [_jsxs("div", { className: "user-info", ref: userMenuRef, children: [_jsxs("div", { className: "user-info-main", onClick: () => setShowUserMenu(!showUserMenu), children: [_jsx("div", { className: "avatar", children: currentUser.avatar || "👤" }), _jsx("div", { className: "username", children: currentUser.nickname
                                            ? `${currentUser.username} (${currentUser.nickname})`
                                            : currentUser.username }), _jsx(ConnectionStatus, { state: connectionState, reconnectAttempt: reconnectAttempt }), _jsx("div", { className: "menu-arrow", children: showUserMenu ? "▲" : "▼" })] }), showUserMenu && (_jsxs("div", { className: "user-menu-dropdown", children: [currentUser.role === "admin" && (_jsxs("button", { onClick: () => { setShowCreateUser(true); setShowUserMenu(false); }, children: [_jsx("span", { children: "\uD83D\uDC64" }), " \u521B\u5EFA\u7528\u6237"] })), _jsxs("button", { onClick: () => { setShowChangeNickname(true); setShowUserMenu(false); }, children: [_jsx("span", { children: "\u270F\uFE0F" }), " \u4FEE\u6539\u6635\u79F0"] }), _jsxs("button", { onClick: () => { setShowChangePassword(true); setShowUserMenu(false); }, children: [_jsx("span", { children: "\uD83D\uDD12" }), " \u4FEE\u6539\u5BC6\u7801"] }), _jsx("div", { className: "menu-divider" }), _jsxs("button", { onClick: () => { handleLogout(); setShowUserMenu(false); }, className: "logout-item", children: [_jsx("span", { children: "\uD83D\uDEAA" }), " \u9000\u51FA\u767B\u5F55"] })] }))] }), _jsxs("div", { className: "room-list", children: [_jsxs("div", { className: "room-list-header", children: [_jsx("span", { children: "\u804A\u5929" }), _jsxs("div", { className: "room-actions", children: [_jsx("button", { onClick: () => setShowUserList(true), className: "add-room-button", title: "\u65B0\u804A\u5929", children: "+" }), _jsx("button", { onClick: handleCreateBotRoom, className: "add-room-button", title: "AI\u52A9\u624B", children: "\uD83E\uDD16" })] })] }), rooms.map((room) => (_jsxs("div", { className: `room-item ${selectedRoom?.id === room.id ? "active" : ""}`, onClick: () => handleSelectRoom(room), children: [_jsx("div", { className: "room-avatar", children: room.avatar || (room.type === "bot" ? "🤖" : "💬") }), _jsxs("div", { className: "room-info", children: [_jsx("div", { className: "room-name", children: room.name }), _jsx("div", { className: "room-type", children: room.type === "bot" ? "AI助手" : room.type === "group" ? "群聊" : "私聊" })] }), unreadCounts.get(room.id) ? (_jsx("div", { className: "unread-badge", children: unreadCounts.get(room.id) })) : null, room.type === "bot" && (_jsx("button", { onClick: (e) => handleDeleteRoom(room.id, room.type, e), className: "delete-room-button", children: "\u00D7" }))] }, room.id)))] })] }), _jsx("div", { className: "chat-area", children: selectedRoom ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "chat-header", children: _jsxs("div", { className: "chat-title", children: [_jsx("span", { className: "chat-avatar", children: selectedRoom.avatar || (selectedRoom.type === "bot" ? "🤖" : "💬") }), _jsx("span", { className: "chat-name", children: selectedRoom.name })] }) }), _jsx("div", { className: "messages-container", ref: messagesContainerRef, children: messages.map((message) => {
                                const user = getUserById(message.user_id);
                                const isOwnMessage = message.user_id === currentUser.id;
                                return (_jsxs("div", { className: `message ${isOwnMessage ? "own" : "other"}`, children: [!isOwnMessage && (_jsx("div", { className: "message-avatar", children: user?.avatar || "👤" })), _jsxs("div", { className: "message-content", children: [!isOwnMessage && (_jsx("div", { className: "message-sender", children: getDisplayName(user) })), _jsx(MessageContentRenderer, { message: message }), _jsx("div", { className: "message-time", children: formatTime(message.created_at) })] })] }, message.id));
                            }) }), _jsxs("div", { className: "input-area", children: [_jsx("input", { type: "file", ref: fileInputRef, style: { display: "none" }, onChange: handleFileSelect, accept: "image/*,audio/*,video/*,.pdf,.doc,.docx,.txt" }), _jsx("button", { onClick: () => fileInputRef.current?.click(), className: "attach-button", disabled: connectionState !== "connected", title: "\u53D1\u9001\u6587\u4EF6", children: "\uD83D\uDCCE" }), _jsx("input", { type: "text", className: "message-input", placeholder: "\u8F93\u5165\u6D88\u606F...", value: messageInput, onChange: (e) => setMessageInput(e.target.value), onKeyPress: (e) => e.key === "Enter" && handleSendMessage(), disabled: connectionState !== "connected" }), _jsx("button", { onClick: handleSendMessage, className: "send-button", disabled: connectionState !== "connected", children: "\u53D1\u9001" })] })] })) : (_jsxs("div", { className: "empty-state", children: [_jsx("div", { className: "empty-icon", children: "\uD83D\uDCAC" }), _jsx("div", { className: "empty-text", children: "\u9009\u62E9\u4E00\u4E2A\u804A\u5929\u5F00\u59CB\u5BF9\u8BDD" })] })) }), showCreateUser && _jsx(CreateUserModal, { onClose: () => setShowCreateUser(false) }), showUserList && _jsx(UserListModal, { onClose: () => setShowUserList(false), onUserSelected: handleUserSelected }), showChangePassword && _jsx(ChangePasswordModal, { onClose: () => setShowChangePassword(false) }), showChangeNickname && (_jsx(ChangeNicknameModal, { onClose: () => setShowChangeNickname(false), currentNickname: currentUser?.nickname, onNicknameChanged: (nickname) => {
                    if (currentUser) {
                        const updatedUser = { ...currentUser, nickname };
                        setCurrentUser(updatedUser);
                        localStorage.setItem("user", JSON.stringify(updatedUser));
                    }
                } }))] }));
}
// Modals
function CreateUserModal({ onClose }) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState(false);
    const handleCreate = async (e) => {
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
            const data = (await response.json());
            if (data.success) {
                setSuccess(true);
                setTimeout(onClose, 1500);
            }
            else {
                setError(data.error || "创建失败");
            }
        }
        catch {
            setError("网络错误");
        }
    };
    return (_jsx("div", { className: "modal-overlay", onClick: onClose, children: _jsxs("div", { className: "modal-content", onClick: (e) => e.stopPropagation(), children: [_jsx("h2", { children: "\u521B\u5EFA\u7528\u6237" }), success ? (_jsx("div", { className: "success-message", children: "\u521B\u5EFA\u6210\u529F\uFF01" })) : (_jsxs("form", { onSubmit: handleCreate, children: [_jsxs("div", { className: "form-group", children: [_jsx("label", { children: "\u7528\u6237\u540D" }), _jsx("input", { type: "text", value: username, onChange: (e) => setUsername(e.target.value), required: true })] }), _jsxs("div", { className: "form-group", children: [_jsx("label", { children: "\u5BC6\u7801" }), _jsx("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), required: true })] }), error && _jsx("div", { className: "error-message", children: error }), _jsxs("div", { className: "modal-buttons", children: [_jsx("button", { type: "button", onClick: onClose, children: "\u53D6\u6D88" }), _jsx("button", { type: "submit", children: "\u521B\u5EFA" })] })] }))] }) }));
}
function UserListModal({ onClose, onUserSelected }) {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        const fetchUsers = async () => {
            try {
                const session = JSON.parse(localStorage.getItem("session") || "{}");
                const response = await fetch("/api/users", {
                    headers: { Authorization: `Bearer ${session.id}` },
                });
                const data = (await response.json());
                if (data.success && data.data) {
                    setUsers(data.data);
                }
            }
            catch {
                // Ignore load users error
            }
            finally {
                setLoading(false);
            }
        };
        fetchUsers();
    }, []);
    return (_jsx("div", { className: "modal-overlay", onClick: onClose, children: _jsxs("div", { className: "modal-content", onClick: (e) => e.stopPropagation(), children: [_jsx("h2", { children: "\u53D1\u8D77\u65B0\u804A\u5929" }), loading ? (_jsx("div", { children: "\u52A0\u8F7D\u4E2D..." })) : (_jsx("div", { className: "user-list", children: users.length === 0 ? (_jsx("div", { className: "empty-message", children: "\u6CA1\u6709\u5176\u4ED6\u7528\u6237" })) : (users.map((user) => (_jsxs("div", { className: "user-list-item", onClick: () => onUserSelected(user.id), children: [_jsx("div", { className: "avatar", children: user.avatar || "👤" }), _jsx("div", { className: "user-info", children: _jsx("div", { className: "username", children: user.nickname || user.username }) })] }, user.id)))) })), _jsx("div", { className: "modal-buttons", children: _jsx("button", { onClick: onClose, children: "\u53D6\u6D88" }) })] }) }));
}
function ChangePasswordModal({ onClose }) {
    const [oldPassword, setOldPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState(false);
    const handleSubmit = async (e) => {
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
            const data = (await response.json());
            if (data.success) {
                setSuccess(true);
                setTimeout(onClose, 1500);
            }
            else {
                setError(data.error || "修改失败");
            }
        }
        catch {
            setError("网络错误");
        }
    };
    return (_jsx("div", { className: "modal-overlay", onClick: onClose, children: _jsxs("div", { className: "modal-content", onClick: (e) => e.stopPropagation(), children: [_jsx("h2", { children: "\u4FEE\u6539\u5BC6\u7801" }), success ? (_jsx("div", { className: "success-message", children: "\u4FEE\u6539\u6210\u529F\uFF01" })) : (_jsxs("form", { onSubmit: handleSubmit, children: [_jsxs("div", { className: "form-group", children: [_jsx("label", { children: "\u65E7\u5BC6\u7801" }), _jsx("input", { type: "password", value: oldPassword, onChange: (e) => setOldPassword(e.target.value), required: true })] }), _jsxs("div", { className: "form-group", children: [_jsx("label", { children: "\u65B0\u5BC6\u7801" }), _jsx("input", { type: "password", value: newPassword, onChange: (e) => setNewPassword(e.target.value), required: true })] }), _jsxs("div", { className: "form-group", children: [_jsx("label", { children: "\u786E\u8BA4\u65B0\u5BC6\u7801" }), _jsx("input", { type: "password", value: confirmPassword, onChange: (e) => setConfirmPassword(e.target.value), required: true })] }), error && _jsx("div", { className: "error-message", children: error }), _jsxs("div", { className: "modal-buttons", children: [_jsx("button", { type: "button", onClick: onClose, children: "\u53D6\u6D88" }), _jsx("button", { type: "submit", children: "\u786E\u8BA4" })] })] }))] }) }));
}
function ChangeNicknameModal({ onClose, currentNickname, onNicknameChanged, }) {
    const [nickname, setNickname] = useState(currentNickname || "");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState(false);
    const handleSubmit = async (e) => {
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
            const data = (await response.json());
            if (data.success) {
                setSuccess(true);
                onNicknameChanged?.(nickname);
                setTimeout(onClose, 1500);
            }
            else {
                setError(data.error || "修改失败");
            }
        }
        catch {
            setError("网络错误");
        }
    };
    return (_jsx("div", { className: "modal-overlay", onClick: onClose, children: _jsxs("div", { className: "modal-content", onClick: (e) => e.stopPropagation(), children: [_jsx("h2", { children: "\u4FEE\u6539\u6635\u79F0" }), success ? (_jsx("div", { className: "success-message", children: "\u4FEE\u6539\u6210\u529F\uFF01" })) : (_jsxs("form", { onSubmit: handleSubmit, children: [_jsxs("div", { className: "form-group", children: [_jsx("label", { children: "\u6635\u79F0" }), _jsx("input", { type: "text", value: nickname, onChange: (e) => setNickname(e.target.value), placeholder: "1-20\u5B57\u7B26", maxLength: 20, required: true })] }), error && _jsx("div", { className: "error-message", children: error }), _jsxs("div", { className: "modal-buttons", children: [_jsx("button", { type: "button", onClick: onClose, children: "\u53D6\u6D88" }), _jsx("button", { type: "submit", children: "\u786E\u8BA4" })] })] }))] }) }));
}
// App
function App() {
    return (_jsx(BrowserRouter, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(Navigate, { to: "/login" }) }), _jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { path: "/chat", element: _jsx(ChatPage, {}) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/login" }) })] }) }));
}
createRoot(document.getElementById("root")).render(_jsx(App, {}));
