import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: ToastItem[];
  push(t: Omit<ToastItem, 'id'>, durationMs?: number): void;
  dismiss(id: number): void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push(t, durationMs = t.tone === 'error' ? 8000 : 4000) {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    setTimeout(() => get().dismiss(id), durationMs);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export const toast = {
  info: (message: string, action?: ToastItem['action']) => useToastStore.getState().push({ tone: 'info', message, action }),
  success: (message: string, action?: ToastItem['action']) => useToastStore.getState().push({ tone: 'success', message, action }),
  error: (message: string, action?: ToastItem['action']) => useToastStore.getState().push({ tone: 'error', message, action }),
};
