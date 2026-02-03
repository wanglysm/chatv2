import { useEffect, useRef, useCallback, useState } from "react";
import PartySocket from "partysocket";
import type { WSMessage } from "../../shared";

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const RECONNECT_BASE_DELAY = 1000; // 1 second
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

		// Clear any pending reconnect
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}

		setConnectionState(reconnectAttempt > 0 ? "reconnecting" : "connecting");

		const socket = new PartySocket({
			host: window.location.host,
			room: "ChatV2",
		});

		socket.addEventListener("open", () => {
			setConnectionState("connected");
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
			setConnectionState("disconnected");
			clearHeartbeat();
			onDisconnectRef.current?.();

			// Schedule reconnect with exponential backoff
			const delay = Math.min(
				RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempt),
				MAX_RECONNECT_DELAY
			);

			setReconnectAttempt((prev) => prev + 1);

			reconnectTimeoutRef.current = setTimeout(() => {
				connect();
			}, delay);
		});

		socket.addEventListener("error", () => {
			// WebSocket error
		});

		socketRef.current = socket;
	}, [sessionId, reconnectAttempt, startHeartbeat, clearHeartbeat]);

	// Initial connection
	useEffect(() => {
		if (sessionId) {
			connect();
		}

		return () => {
			// Cleanup on unmount
			clearHeartbeat();
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
			if (socketRef.current) {
				socketRef.current.close();
			}
		};
	}, [sessionId, connect, clearHeartbeat]);

	// Handle page visibility changes
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible" && socketRef.current?.readyState !== WebSocket.OPEN) {
				if (sessionId) {
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

	return {
		socket: socketRef.current,
		connectionState,
		reconnectAttempt,
		joinRoom,
		leaveRoom,
		sendMessage,
		syncMessages,
	};
}
