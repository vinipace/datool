/** Action mentions use stable per-agent slugs, so cloned skills keep their links. */
export function skillActionSlugs(instructions: string): string[] {
  return [
    ...new Set(
      [
        ...instructions.matchAll(/\]\(action:([a-z0-9][a-z0-9_-]{0,119})\)/g),
      ].map((match) => match[1])
    ),
  ]
}
