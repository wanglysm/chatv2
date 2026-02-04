
import { useEffect, useRef, useCallback, useState } from "react";
import PartySocket from "partysocket";
import type { WSMessage } from "../../shared";

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const RECONNECT_BASE_DELAY = 3000; // 3 seconds
const MAX_RECONNECT_DELAY = 30000; // 30 seconds

type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

interface UseWebSocketOptions {
	sessionId: string | null;
	onMessage?: (message: WSMessage) => void;
	onConnect?: () => void;
	onDisconnect?: () => void;
}

interface UseWebSocketReturn {
	socket: PartySocket | null;
	connectionState: ConnectionState;
	reconnectAttempt: number;
	joinRoom: (roomId: string) => void;
	leaveRoom: (roomId: string) => void;
	sendMessage: (message: Omit<WSMessage, "type"> & { type: string }) => void;
	syncMessages: (lastMessageId?: string) => void;
	ackMessage: (messageId: string, status: "delivered" | "read") => void;
}

export function useWebSocket({
	sessionId,
	onMessage,
	onConnect,
	onDisconnect,
}: UseWebSocketOptions): UseWebSocketReturn {
	const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
	const [reconnectAttempt, setReconnectAttempt] = useState(0);

	const socketRef = useRef<PartySocket | null>(null);
	const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const joinedRoomsRef = useRef<Set<string>>(new Set());
	const onMessageRef = useRef(onMessage);
	const onConnectRef = useRef(onConnect);
	const onDisconnectRef = useRef(onDisconnect);
	// 使用 ref 存储重连次数，避免触发重新渲染导致 connect 函数重建
	const reconnectAttemptRef = useRef(0);
	// 连接中标志，防止重复连接
	const isConnectingRef = useRef(false);
	// 关闭标志，防止组件卸载后还执行重连
	const isClosedRef = useRef(false);

	// Keep callbacks up to date
	useEffect(() => {
		onMessageRef.current = onMessage;
		onConnectRef.current = onConnect;
		onDisconnectRef.current = onDisconnect;
	}, [onMessage, onConnect, onDisconnect]);

	const clearHeartbeat = useCallback(() => {
		if (heartbeatIntervalRef.current) {
			clearInterval(heartbeatIntervalRef.current);
			heartbeatIntervalRef.current = null;
		}
	}, []);

	const startHeartbeat = useCallback((socket: PartySocket) => {
		clearHeartbeat();
		heartbeatIntervalRef.current = setInterval(() => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
			}
		}, HEARTBEAT_INTERVAL);
	}, [clearHeartbeat]);

	const connect = useCallback(() => {
		if (!sessionId) return;
		// 如果已经在连接中，不要重复连接
		if (isConnectingRef.current) {
			return;
		}
		// 如果组件已卸载，不再连接
		if (isClosedRef.current) {
			return;
		}
		// 如果已经有连接且状态不是 CLOSED，先关闭
		if (socketRef.current && socketRef.current.readyState !== WebSocket.CLOSED) {
			socketRef.current.close();
			socketRef.current = null;
		}

		// 清除任何待定的重连定时器
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}

		isConnectingRef.current = true;
		setConnectionState(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");

		const socket = new PartySocket({
			host: window.location.host,
			room: "ChatV2",
		});

		socket.addEventListener("open", () => {
			isConnectingRef.current = false;
			setConnectionState("connected");
			// 重置重连计数
			reconnectAttemptRef.current = 0;
			setReconnectAttempt(0);

			// Authenticate
			socket.send(JSON.stringify({ type: "auth", session_id: sessionId }));

			// Start heartbeat
			startHeartbeat(socket);

			// Rejoin rooms if reconnecting
			if (joinedRoomsRef.current.size > 0) {
				joinedRoomsRef.current.forEach((roomId) => {
					socket.send(JSON.stringify({ type: "join_room", room_id: roomId }));
				});
			}

			onConnectRef.current?.();
		});

		socket.addEventListener("message", (event) => {
			try {
				const message = JSON.parse(event.data) as WSMessage;

				if (message.type === "pong") {
					// Heartbeat response, connection is alive
					return;
				}

				if (message.type === "auth_success") {
					return;
				}

				if (message.type === "auth_error") {
					return;
				}

				if (message.type === "room_joined") {
					joinedRoomsRef.current.add(message.room_id);
					return;
				}

				if (message.type === "room_left") {
					joinedRoomsRef.current.delete(message.room_id);
					return;
				}

				onMessageRef.current?.(message);
			} catch (error) {
				// Failed to parse message
			}
		});

		socket.addEventListener("close", () => {
			isConnectingRef.current = false;
			setConnectionState("disconnected");
			clearHeartbeat();
			onDisconnectRef.current?.();

			// 如果组件已卸载，不再重连
			if (isClosedRef.current) {
				return;
			}

			// 增加重连计数
			reconnectAttemptRef.current += 1;
			setReconnectAttempt(reconnectAttemptRef.current);

			// Schedule reconnect with exponential backoff
			const delay = Math.min(
				RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttemptRef.current - 1),
				MAX_RECONNECT_DELAY
			);

			reconnectTimeoutRef.current = setTimeout(() => {
				reconnectTimeoutRef.current = null;
				connect();
			}, delay);
		});

		socket.addEventListener("error", () => {
			// WebSocket error
		});

		socketRef.current = socket;
	}, [sessionId, startHeartbeat, clearHeartbeat]);

	// Initial connection
	useEffect(() => {
		isClosedRef.current = false;
		if (sessionId) {
			connect();
		}

		return () => {
			// Cleanup on unmount
			isClosedRef.current = true;
			clearHeartbeat();
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
				reconnectTimeoutRef.current = null;
			}
			if (socketRef.current) {
				socketRef.current.close();
				socketRef.current = null;
			}
			isConnectingRef.current = false;
		};
	}, [sessionId, connect, clearHeartbeat]);

	// Handle page visibility changes
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				// 只有当前没有连接且不在连接中时才重新连接
				if (socketRef.current?.readyState !== WebSocket.OPEN && 
				    socketRef.current?.readyState !== WebSocket.CONNECTING &&
				    !isConnectingRef.current &&
				    sessionId) {
					connect();
				}
			}
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [sessionId, connect]);

	const joinRoom = useCallback((roomId: string) => {
		if (socketRef.current?.readyState === WebSocket.OPEN) {
			socketRef.current.send(JSON.stringify({ type: "join_room", room_id: roomId }));
		}
	}, []);

	const leaveRoom = useCallback((roomId: string) => {
		joinedRoomsRef.current.delete(roomId);
		if (socketRef.current?.readyState === WebSocket.OPEN) {
			socketRef.current.send(JSON.stringify({ type: "leave_room", room_id: roomId }));
		}
	}, []);

	const sendMessage = useCallback((message: Omit<WSMessage, "type"> & { type: string }) => {
		if (socketRef.current?.readyState === WebSocket.OPEN) {
			socketRef.current.send(JSON.stringify(message));
		}
	}, []);

	const syncMessages = useCallback((lastMessageId?: string) => {
		if (socketRef.current?.readyState === WebSocket.OPEN) {
			socketRef.current.send(JSON.stringify({
				type: "sync_request",
				last_message_id: lastMessageId,
			}));
		}
	}, []);

	// Track pending acks that need to be sent when connection is ready
	const pendingAcksRef = useRef<Array<{ messageId: string; status: "delivered" | "read" }>>([]);

	const ackMessage = useCallback((messageId: string, status: "delivered" | "read") => {
		if (socketRef.current?.readyState === WebSocket.OPEN) {
			socketRef.current.send(JSON.stringify({
				type: "message_ack",
				message_id: messageId,
				status,
			}));
		} else {
			// Queue ack to be sent when connection is ready
			pendingAcksRef.current.push({ messageId, status });
		}
	}, []);

	// Send pending acks when connection opens
	useEffect(() => {
		if (connectionState === "connected" && pendingAcksRef.current.length > 0) {
			const pending = [...pendingAcksRef.current];
			pendingAcksRef.current = [];
			pending.forEach(({ messageId, status }) => {
				ackMessage(messageId, status);
			});
		}
	}, [connectionState, ackMessage]);

	return {
		socket: socketRef.current,
		connectionState,
		reconnectAttempt,
		joinRoom,
		leaveRoom,
		sendMessage,
		syncMessages,
		ackMessage,
	};
}
