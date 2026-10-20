import type { AbstractChat, ChatInit, ChatState, ChatStatus, UIMessage } from 'ai'

type AiModule = typeof import('ai')
type Chat<M extends UIMessage> = AbstractChat<M>

/**
 * `useChat` from @ai-sdk/vue, with `ai` (and the zod it validates the stream
 * with, about a third of the page's JavaScript) loaded on first use instead
 * of with the page. `warm()` starts the download on intent.
 */
export function useLazyChat<M extends UIMessage>(init: (ai: AiModule) => Omit<ChatInit<M>, 'messages'>) {
  const messages = shallowRef<M[]>([])
  const status = shallowRef<ChatStatus>('ready')
  const error = shallowRef<Error>()
  const state: ChatState<M> = {
    get messages() { return messages.value },
    set messages(list) { messages.value = list },
    get status() { return status.value },
    set status(value) { status.value = value },
    get error() { return error.value },
    set error(value) { error.value = value },
    pushMessage: (message) => {
      messages.value.push(message)
      triggerRef(messages)
    },
    popMessage: () => {
      messages.value.pop()
      triggerRef(messages)
    },
    replaceMessage: (index, message) => {
      messages.value[index] = { ...message }
      triggerRef(messages)
    },
    snapshot: value => value,
  }

  let chat: Promise<Chat<M>> | undefined
  function load() {
    chat ??= import('ai').then((ai) => {
      class VueChat extends ai.AbstractChat<M> {}
      return new VueChat({ ...init(ai), state })
    })
    chat.catch(() => { chat = undefined })
    return chat
  }

  /** Runs `run` on the chat; a failed download ends as a request error. */
  async function withChat(run: (c: Chat<M>) => Promise<void>) {
    // Busy at once, as `useChat` is: the guards and the status row see it.
    status.value = 'submitted'
    let c: Chat<M>
    try {
      c = await load()
    }
    catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e))
      status.value = 'error'
      return
    }
    await run(c)
  }

  return {
    messages,
    status,
    error,
    warm: () => { void load().catch(() => {}) },
    sendMessage: (...args: Parameters<Chat<M>['sendMessage']>) => withChat(c => c.sendMessage(...args)),
    regenerate: (...args: Parameters<Chat<M>['regenerate']>) => withChat(c => c.regenerate(...args)),
    stop: async () => { await (await chat)?.stop() },
    clearError: () => {
      if (status.value !== 'error') return
      error.value = undefined
      status.value = 'ready'
    },
  }
}
