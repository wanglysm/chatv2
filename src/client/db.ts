import type { Message, User } from "../shared";

const DB_NAME = "ChatV2DB";
const DB_VERSION = 1;

interface ChatData {
	roomId: string;
	messages: Message[];
	users: User[];
	lastUpdated: number;
}

class ChatDatabase {
	private db: IDBDatabase | null = null;

	async init(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				this.db = request.result;
				resolve();
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				if (!db.objectStoreNames.contains("messages")) {
					db.createObjectStore("messages", { keyPath: "roomId" });
				}
			};
		});
	}

	async saveRoomData(roomId: string, messages: Message[], users: User[]): Promise<void> {
		if (!this.db) await this.init();
		if (!this.db) throw new Error("Database not initialized");

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction(["messages"], "readwrite");
			const store = transaction.objectStore("messages");

			const data: ChatData = {
				roomId,
				messages,
				users,
				lastUpdated: Date.now(),
			};

			const request = store.put(data);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}

	async getRoomData(roomId: string): Promise<ChatData | null> {
		if (!this.db) await this.init();
		if (!this.db) return null;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction(["messages"], "readonly");
			const store = transaction.objectStore("messages");
			const request = store.get(roomId);

			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result || null);
		});
	}

	async addMessage(roomId: string, message: Message, user?: User): Promise<void> {
		if (!this.db) await this.init();
		if (!this.db) throw new Error("Database not initialized");

		const data = await this.getRoomData(roomId);
		const messages = data?.messages || [];
		const users = data?.users || [];

		// Check if message already exists
		if (!messages.some((m) => m.id === message.id)) {
			messages.push(message);
			messages.sort((a, b) => a.created_at - b.created_at);
		}

		// Add user if provided and not exists
		if (user && !users.some((u) => u.id === user.id)) {
			users.push(user);
		}

		await this.saveRoomData(roomId, messages, users);
	}

	async clearRoomData(roomId: string): Promise<void> {
		if (!this.db) await this.init();
		if (!this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction(["messages"], "readwrite");
			const store = transaction.objectStore("messages");
			const request = store.delete(roomId);

			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}
}

export const chatDB = new ChatDatabase();
