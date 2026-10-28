import { Text, View } from "react-native"
import { Icon } from "./icons"
import { styles } from "./styles"
import colors from "../theme.generated.json"

/** `grouped` follows an earlier bubble from the same author; `tail` marks the newest bubble of a run. */
export function MessageBubble({ text, outgoing, author, time, status, error, grouped = false, tail = true }: {
  text: string; outgoing?: boolean; author?: string; time: string;
  status?: "queued" | "sending" | "blocked" | "submitted"; error?: string; grouped?: boolean; tail?: boolean;
}) {
  const label = status === "blocked" ? "Needs attention · Open Outbox" : status === "queued" ? "Queued on this phone" : status === "sending" ? "Sending…" : undefined
  const inlineMeta = !label && !error
  // Nonbreaking glyphs reserve the timestamp's last-line width. Trailing spaces
  // alone are discarded by native text layout and let the timestamp overlap.
  const metaSpace = `\u00a0\u00a0${time.replaceAll(" ", "\u00a0")}${status ? "\u00a0✓✓" : ""}`
  return <View style={[styles.messageWrap, !grouped && { paddingTop: 7 }]}><View style={[styles.bubble, outgoing && styles.outgoingBubble, tail && (outgoing ? styles.outgoingTail : styles.incomingTail)]}>
    {!!author && <Text style={styles.author}>{author}</Text>}
    <Text accessibilityLabel={text} style={styles.messageText}><Text selectable>{text}</Text>{inlineMeta && <Text accessible={false} style={[styles.metaText, styles.messageMetaSpace]}>{metaSpace}</Text>}</Text>
    {label && <Text style={[styles.metaText, { marginTop: 5 }, status === "blocked" && { color: colors.error }]}>{label}</Text>}
    {!!error && <Text accessibilityRole={status === "blocked" ? "alert" : undefined} style={[styles.messageError, status !== "blocked" && { color: colors.messageMeta }]}>{error}</Text>}
    <View style={[styles.messageMeta, inlineMeta && styles.messageMetaInline]}><Text style={styles.metaText}>{time}</Text>{status && <View accessible accessibilityLabel={status === "submitted" ? "Submitted to Datool" : label}><Icon name={status === "submitted" ? "check" : "clock"} size={13} color={colors.messageMeta} /></View>}</View>
  </View></View>
}
