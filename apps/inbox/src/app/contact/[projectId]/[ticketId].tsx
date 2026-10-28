import { ScrollView, Text, View } from "react-native"
import { router, useLocalSearchParams } from "expo-router"
import { Stack } from "expo-router/stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useQuery } from "@tanstack/react-query"
import { build } from "../../../lib/api"
import { channelLabel } from "../../../lib/channels"
import { useOnline } from "../../../lib/offline"
import type { Contact, Ticket } from "../../../lib/types"
import { ChannelAvatar } from "../../../components/channel-avatar"
import { ProfileAction, ProfileDetail } from "../../../components/profile"
import { IconButton, Notice, State, TextAction } from "../../../components/ui"
import { styles } from "../../../components/styles"

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

export default function ContactInfo() {
  const { projectId, ticketId } = useLocalSearchParams<{ projectId: string; ticketId: string }>()
  const insets = useSafeAreaInsets()
  const online = useOnline()
  const ticket = useQuery({ queryKey: ["ticket", projectId, ticketId], queryFn: ({ signal }) => build<Ticket>(projectId, "build_get_ticket", { id: ticketId }, { signal }) })
  const contactId = ticket.data?.contactId
  const contact = useQuery({ queryKey: ["contact", projectId, contactId], enabled: !!contactId,
    queryFn: ({ signal }) => build<Contact>(projectId, "build_get_contact", { id: contactId }, { signal }) })
  function conversation(manage = false) {
    router.dismissTo({ pathname: "/ticket/[projectId]/[ticketId]", params: { projectId, ticketId, ...(manage ? { showActions: "1" } : {}) } })
  }
  const name = contact.data?.displayName || ticket.data?.contactName || "Customer"
  return <View style={[styles.screen, { paddingTop: insets.top }]}>
    <Stack.Screen options={{ title: "Contact info", headerShown: false }} />
    <View style={styles.frame}>
      <View style={styles.profileToolbar}>
        <IconButton name="back" label="Back to conversation" onPress={() => conversation()} />
        <Text accessibilityRole="header" style={styles.profileTitle}>Contact info</Text>
        <View style={styles.profileToolbarBalance} />
      </View>
      {!ticket.data ? <State loading={ticket.isPending && online} title={online ? "Contact unavailable" : "Contact not saved yet"} description={online ? undefined : "Reconnect to load this contact."} error={ticket.error} retry={online ? () => void ticket.refetch() : undefined} /> :
        <ScrollView contentContainerStyle={[styles.contactContent, { paddingBottom: Math.max(24, insets.bottom) }]} contentInsetAdjustmentBehavior="never">
          <View style={styles.contactHero}>
            <ChannelAvatar name={name} channel={ticket.data.channel} identityKey={ticket.data.contactId || ticket.data.conversationId} size={120} />
            <View style={styles.contactIdentity}>
              <Text selectable style={styles.accountName}>{name}</Text>
              <Text selectable style={styles.contactSubtitle}>{contact.data?.phone || contact.data?.email || channelLabel(ticket.data.channel)}</Text>
            </View>
          </View>
          <View style={styles.profileActions}>
            <ProfileAction icon="chats" title="Message" onPress={() => conversation()} />
            <ProfileAction icon="headset" title="Manage" onPress={() => conversation(true)} />
          </View>
          <View style={styles.accountGroup}>
            <ProfileDetail icon="globe" title="Channel" value={channelLabel(ticket.data.channel)} />
            <View style={styles.divider} />
            <ProfileDetail icon="user" title="Assigned to" value={ticket.data.assigneeName || ticket.data.teamName || "Unassigned"} />
            <View style={styles.divider} />
            <ProfileDetail icon="chats" title="Status" value={titleCase(ticket.data.status)} />
          </View>
          {(contact.data?.email || contact.data?.phone) && <View style={styles.accountGroup}>
            {contact.data.phone && <ProfileDetail icon="phone" title="Phone" value={contact.data.phone} stacked />}
            {contact.data.phone && contact.data.email && <View style={styles.divider} />}
            {contact.data.email && <ProfileDetail icon="mail" title="Email" value={contact.data.email} stacked />}
          </View>}
          {!!contactId && !contact.data && <View style={styles.contactNotice}>
            {contact.isPending && online ? <Text style={styles.quietCaption}>Loading contact details…</Text> : <>
              <Text style={styles.quietCaption}>{online ? "Contact details couldn’t be loaded." : "Contact details aren’t saved on this phone yet."}</Text>
              <Notice error={contact.error} />
              {online && <TextAction title="Retry contact details" onPress={() => void contact.refetch()} />}
            </>}
          </View>}
          <View style={styles.accountGroup}>
            <ProfileDetail icon="flag" title="Priority" value={titleCase(ticket.data.priority)} />
            {!!ticket.data.subject && <><View style={styles.divider} /><ProfileDetail icon="info" title="About this conversation" value={ticket.data.subject} stacked /></>}
          </View>
          {!online && <Text style={styles.contactSaved}>Offline · Showing saved details</Text>}
        </ScrollView>}
    </View>
  </View>
}
