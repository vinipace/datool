import { describe, expect, test } from "bun:test"
import { chatBubbleSettingsSchema } from "@/src/lib/build/chat-bubble"
import {
  localizeBubble,
  resolveBubbleLanguage,
  resolveBubbleLauncher,
} from "@/src/lib/build/bubble-localization"

describe("Chat Bubble localization", () => {
  test("negotiates only enabled languages and honors fixed and fallback choices", () => {
    const settings = chatBubbleSettingsSchema.parse({
      localization: {
        source: "browser",
        languages: ["en", "pt-BR"],
        defaultLanguage: "en",
      },
    })
    expect(resolveBubbleLanguage(settings, "pt-PT, en;q=0.8")).toBe("pt-BR")
    expect(resolveBubbleLanguage(settings, "es-MX, pt-BR;q=0.8")).toBe("pt-BR")
    expect(resolveBubbleLanguage(settings, "es-MX")).toBe("en")
    expect(
      resolveBubbleLanguage(
        {
          ...settings,
          localization: { ...settings.localization, source: "fixed" },
        },
        "pt-BR"
      )
    ).toBe("en")
  })

  test("uses translated content and launcher labels without discarding shared content", () => {
    const settings = chatBubbleSettingsSchema.parse({
      welcomeMessage: "Welcome",
      launcherLabel: "Help",
      localization: {
        source: "fixed",
        defaultLanguage: "pt-BR",
        languages: ["en", "pt-BR"],
        translations: {
          "pt-BR": { welcomeMessage: "Olá!", launcherLabel: "Ajuda" },
        },
      },
    })
    expect(localizeBubble(settings).appearance.welcomeMessage).toBe("Olá!")
    expect(localizeBubble(settings).appearance.inputPlaceholder).toBe(
      "Envie uma mensagem"
    )
    expect(resolveBubbleLauncher(settings).label).toBe("Ajuda")
    const fallback = {
      ...settings,
      localization: { ...settings.localization, translations: {} },
    }
    expect(localizeBubble(fallback).appearance.welcomeMessage).toBe("Welcome")
    expect(resolveBubbleLauncher(fallback).label).toBe("Help")
  })
})
