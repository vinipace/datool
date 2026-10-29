import { describe, expect, test } from "bun:test"
import { chatBubbleSettingsSchema } from "@/src/lib/build/chat-bubble"
import {
  localizeBubble,
  resolveBubbleLanguage,
  resolveBubbleLauncher,
} from "@/src/lib/build/bubble-localization"

describe("Chat Bubble localization", () => {
  test("country selection localizes the whole welcome and falls back to enabled browser languages", () => {
    const settings = chatBubbleSettingsSchema.parse({
      welcomeMessage: "Welcome",
      suggestedReplies: ["See pricing"],
      localization: {
        source: "country",
        languages: ["en", "pt-BR", "es"],
        defaultLanguage: "en",
        translations: {
          "pt-BR": {
            welcomeMessage: "Olá!",
            suggestedReplies: ["Ver preços"],
            inputPlaceholder: "Pergunte sobre a Datool…",
            launcherLabel: "Ajuda",
          },
        },
      },
    })
    const brazil = localizeBubble(settings, "en-US", "BR")
    expect(brazil.appearance.welcomeMessage).toBe("Olá!")
    expect(brazil.appearance.suggestedReplies).toEqual(["Ver preços"])
    expect(brazil.appearance.inputPlaceholder).toBe("Pergunte sobre a Datool…")
    expect(brazil.copy.send).toBe("Enviar mensagem")
    expect(resolveBubbleLauncher(settings, "en-US", "BR").label).toBe("Ajuda")
    for (const [country, browser, expected] of [
      ["br", "en", "pt-BR"],
      ["US", "pt-BR", "en"],
      ["MX", "en", "es"],
      ["ES", "en", "es"],
      ["CA", "pt-BR", "pt-BR"], // Multilingual countries use browser preference.
      ["", "pt-BR", "pt-BR"],
      ["XX", "es-MX", "es"],
      ["T1", "fr", "en"],
    ] as const) {
      expect(resolveBubbleLanguage(settings, browser, country)).toBe(expected)
    }
    const englishOnly = {
      ...settings,
      localization: { ...settings.localization, languages: ["en" as const] },
    }
    expect(resolveBubbleLanguage(englishOnly, "pt-BR", "BR")).toBe("en")
    for (const source of ["browser", "fixed"] as const) {
      expect(
        resolveBubbleLanguage(
          {
            ...settings,
            localization: { ...settings.localization, source },
          },
          "en",
          "BR"
        )
      ).toBe("en")
    }
  })

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
