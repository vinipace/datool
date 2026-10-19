import type { BubbleLanguage, ChatBubbleSettings } from "./chat-bubble"
import { isSafeHttpUrl } from "./urls"

export const bubbleLanguages = [
  { value: "en", label: "English" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "es", label: "Español" },
] as const

export const bubbleCopy = {
  en: {
    assistant: "Assistant",
    open: "Open chat",
    close: "Close chat",
    newChat: "Start a new conversation",
    newChatShort: "New chat",
    conversations: "Previous conversations",
    noConversations: "Your conversations will appear here.",
    loading: "Loading conversation…",
    unavailable: "Couldn't load the chat",
    unavailableDescription: "Please try again in a moment.",
    retry: "Try again",
    start: "How can we help you?",
    thinking: "Thinking…",
    message: "Message",
    placeholder: "Message your assistant",
    send: "Send message",
    branding: "Powered by Datool",
    helpful: "Helpful",
    notHelpful: "Not helpful",
    justNow: "Just now",
    feedback: "Was this helpful?",
  },
  "pt-BR": {
    assistant: "Assistente",
    open: "Abrir conversa",
    close: "Fechar conversa",
    newChat: "Iniciar uma nova conversa",
    newChatShort: "Nova conversa",
    conversations: "Conversas anteriores",
    noConversations: "Suas conversas aparecerão aqui.",
    loading: "Carregando conversa…",
    unavailable: "Não foi possível abrir a conversa",
    unavailableDescription: "Tente novamente em instantes.",
    retry: "Tentar novamente",
    start: "Como podemos ajudar?",
    thinking: "Pensando…",
    message: "Mensagem",
    placeholder: "Envie uma mensagem",
    send: "Enviar mensagem",
    branding: "Desenvolvido com Datool",
    helpful: "Útil",
    notHelpful: "Não foi útil",
    justNow: "Agora mesmo",
    feedback: "Esta resposta foi útil?",
  },
  es: {
    assistant: "Asistente",
    open: "Abrir chat",
    close: "Cerrar chat",
    newChat: "Iniciar una nueva conversación",
    newChatShort: "Nuevo chat",
    conversations: "Conversaciones anteriores",
    noConversations: "Tus conversaciones aparecerán aquí.",
    loading: "Cargando conversación…",
    unavailable: "No se pudo cargar el chat",
    unavailableDescription: "Vuelve a intentarlo en un momento.",
    retry: "Intentar de nuevo",
    start: "¿Cómo podemos ayudarte?",
    thinking: "Pensando…",
    message: "Mensaje",
    placeholder: "Escribe un mensaje",
    send: "Enviar mensaje",
    branding: "Desarrollado con Datool",
    helpful: "Útil",
    notHelpful: "No fue útil",
    justNow: "Ahora mismo",
    feedback: "¿Te resultó útil?",
  },
}

export function resolveBubbleLanguage(
  settings: ChatBubbleSettings,
  browserLanguages = "en"
): BubbleLanguage {
  const config = settings.localization
  if (config.source === "browser") {
    for (const candidate of browserLanguages.split(",")) {
      const language = candidate.split(";")[0]!.trim().toLowerCase()
      const matched = bubbleLanguages.find(
        ({ value }) =>
          value.toLowerCase() === language ||
          value.split("-")[0] === language.split("-")[0]
      )
      if (matched && config.languages.includes(matched.value))
        return matched.value
    }
  }
  return config.defaultLanguage
}

export function localizeBubble(
  settings: ChatBubbleSettings,
  browserLanguages?: string
) {
  const language = resolveBubbleLanguage(settings, browserLanguages)
  const copy = bubbleCopy[language]
  const translated = settings.localization.translations[language] ?? {}
  return {
    language,
    copy,
    appearance: {
      ...settings,
      ...Object.fromEntries(
        Object.entries(translated).filter(([, value]) => value !== undefined)
      ),
      inputPlaceholder:
        translated.inputPlaceholder ??
        (settings.inputPlaceholder === "Message your assistant"
          ? copy.placeholder
          : settings.inputPlaceholder),
    },
  }
}

// One source for the editor tiles, preview, and the external launcher SVG.
export const bubbleIconPaths = {
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z",
  sparkles:
    "M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 0 1 12 3M19 2l1.2 3.8L24 7l-3.8 1.2L19 12l-1.2-3.8L14 7l3.8-1.2L19 2z",
  headset:
    "M3 14v-3a9 9 0 0 1 18 0v3M3 13h2a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm16 0h2a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zM21 20c0 2-3 2-7 2",
}

export function resolveBubbleLauncher(
  settings: ChatBubbleSettings,
  browserLanguages?: string
) {
  const { appearance, copy } = localizeBubble(settings, browserLanguages)
  return {
    iconPath:
      bubbleIconPaths[
        settings.launcherIcon === "custom" ? "chat" : settings.launcherIcon
      ],
    iconUrl:
      settings.launcherIcon === "custom" &&
      settings.launcherIconUrl &&
      isSafeHttpUrl(settings.launcherIconUrl)
        ? settings.launcherIconUrl
        : null,
    label: appearance.launcherLabel,
    openLabel: copy.open,
    closeLabel: copy.close,
    color: settings.launcherColor ?? settings.primaryColor,
  }
}
