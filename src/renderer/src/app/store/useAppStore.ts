import { create } from 'zustand'
import type { Thread, Message, ConnectionStatus, RunStatus } from '../types'

const MOCK_THREADS: Thread[] = [
  { id: 't1', title: "Apple's stock price today", updatedAt: new Date(Date.now() - 60000 * 2), preview: "Based on the search results..." },
  { id: 't2', title: "What do I know?", updatedAt: new Date(Date.now() - 60000 * 10) },
  { id: 't3', title: "I can speak a little French, but I'm not very fluent yet", updatedAt: new Date(Date.now() - 60000 * 30) },
  { id: 't4', title: "我最近在干啥？", updatedAt: new Date(Date.now() - 60000 * 60) },
  { id: 't5', title: "请问我是谁", updatedAt: new Date(Date.now() - 60000 * 90) },
  { id: 't6', title: "眨眼微笑", updatedAt: new Date(Date.now() - 60000 * 120) },
  { id: 't7', title: "png 图片，删掉边缘", updatedAt: new Date(Date.now() - 60000 * 150) },
  { id: 't8', title: "眨眼微笑，只改变人物本...", updatedAt: new Date(Date.now() - 60000 * 180) },
  { id: 't9', title: "我喜欢吃什么水果啊", updatedAt: new Date(Date.now() - 60000 * 240) },
  { id: 't10', title: "特别好", updatedAt: new Date(Date.now() - 60000 * 300) },
  { id: 't11', title: "hello", updatedAt: new Date(Date.now() - 60000 * 360) },
  { id: 't12', title: "你喜欢我吗", updatedAt: new Date(Date.now() - 60000 * 420) },
  { id: 't13', title: "我来自哪儿啊", updatedAt: new Date(Date.now() - 60000 * 480) },
  { id: 't14', title: "删掉关于我来自哪里的记忆", updatedAt: new Date(Date.now() - 60000 * 540) },
  { id: 't15', title: "你是谁，你会啥？", updatedAt: new Date(Date.now() - 60000 * 600) },
]

const MOCK_MESSAGES: Record<string, Message[]> = {
  t3: [
    {
      id: 'm1',
      threadId: 't3',
      role: 'user',
      content: "I can speak a little French, but I'm not very fluent yet",
      status: 'completed',
    },
    {
      id: 'm2',
      threadId: 't3',
      role: 'assistant',
      content: `That's great that you're learning French! 🇫🇷

How long have you been studying? And what drew you to French - is it for travel, work, culture, or just personal interest?

If you ever want to practice a bit here, feel free - I can help with vocabulary, phrases, or just chat in simple French. No pressure though!`,
      status: 'completed',
    },
  ],
  t1: [
    {
      id: 'm3',
      threadId: 't1',
      role: 'user',
      content: "Apple's stock price today",
      status: 'completed',
    },
    {
      id: 'm4',
      threadId: 't1',
      role: 'assistant',
      content: `Based on the search results, here's the Apple stock information I found:

## Apple Inc. (AAPL) Stock Price

**Note:** The search returned data for AAPL.TO (Apple traded on the Toronto Stock Exchange in CAD):

| Metric | Value |
|--------|-------|
| Price | CAD $40.68 |
| Change | -$0.28 (-0.68%) |
| Previous Close | CAD $40.96 |
| Day's Range | CAD 40.61—41.21 |
| 52 Week Range | CAD 24.64—41.21 |
| Market Cap | ~$5.9 Trillion |
| P/E Ratio (TTM) | 36.32 |`,
      status: 'completed',
      toolCalls: [
        { id: 'tc1', tool: 'WebSearch', status: 'completed', durationSec: 109 },
      ],
    },
  ],
}

interface AppState {
  threads: Thread[]
  activeThreadId: string
  messages: Record<string, Message[]>
  connectionStatus: ConnectionStatus
  runStatus: RunStatus
  composerValue: string

  setActiveThread: (id: string) => void
  setComposerValue: (val: string) => void
  createNewThread: () => void
  sendMessage: (content: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  threads: MOCK_THREADS,
  activeThreadId: 't3',
  messages: MOCK_MESSAGES,
  connectionStatus: 'connected',
  runStatus: 'idle',
  composerValue: '',

  setActiveThread: (id) => set({ activeThreadId: id }),

  setComposerValue: (val) => set({ composerValue: val }),

  createNewThread: () => {
    const id = `t_${Date.now()}`
    const newThread: Thread = {
      id,
      title: 'New Chat',
      updatedAt: new Date(),
    }
    set((s) => ({
      threads: [newThread, ...s.threads],
      activeThreadId: id,
      messages: { ...s.messages, [id]: [] },
    }))
  },

  sendMessage: (content) => {
    const { activeThreadId, messages } = get()
    if (!content.trim()) return

    const userMsg: Message = {
      id: `m_${Date.now()}_u`,
      threadId: activeThreadId,
      role: 'user',
      content: content.trim(),
      status: 'completed',
    }

    const streamingMsg: Message = {
      id: `m_${Date.now()}_a`,
      threadId: activeThreadId,
      role: 'assistant',
      content: '',
      status: 'streaming',
    }

    const existing = messages[activeThreadId] ?? []
    set((s) => ({
      composerValue: '',
      runStatus: 'running',
      messages: {
        ...s.messages,
        [activeThreadId]: [...existing, userMsg, streamingMsg],
      },
      threads: s.threads.map((t) =>
        t.id === activeThreadId
          ? { ...t, title: t.title === 'New Chat' ? content.slice(0, 40) : t.title, updatedAt: new Date() }
          : t,
      ),
    }))

    // Simulate streaming response
    const responseText = `I received your message: "${content.trim()}"\n\nThis is a **prototype** response. The real WebSocket connection and model runtime will be wired up in the next milestone. For now, the UI is fully functional and ready to receive actual streaming events.\n\nYou can:\n- Create new threads\n- Switch between conversations\n- See the message timeline with proper bubble styles`

    let i = 0
    const words = responseText.split(' ')
    const interval = setInterval(() => {
      if (i >= words.length) {
        clearInterval(interval)
        set((s) => {
          const msgs = s.messages[activeThreadId] ?? []
          return {
            runStatus: 'idle',
            messages: {
              ...s.messages,
              [activeThreadId]: msgs.map((m) =>
                m.status === 'streaming' ? { ...m, status: 'completed' } : m,
              ),
            },
          }
        })
        return
      }
      set((s) => {
        const msgs = s.messages[activeThreadId] ?? []
        return {
          messages: {
            ...s.messages,
            [activeThreadId]: msgs.map((m) =>
              m.status === 'streaming'
                ? { ...m, content: m.content + (i === 0 ? '' : ' ') + words[i] }
                : m,
            ),
          },
        }
      })
      i++
    }, 40)
  },
}))
