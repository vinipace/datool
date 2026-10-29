import { useRef, useState, type ComponentRef } from "react"
import { Keyboard, Pressable, Text, TextInput, View } from "react-native"
import { router } from "expo-router"
import { useMutation } from "@tanstack/react-query"
import * as Crypto from "expo-crypto"
import * as Linking from "expo-linking"
import * as SecureStore from "expo-secure-store"
import { auth } from "../lib/auth"
import { reportError } from "../lib/diagnostics"
import { Field } from "../components/ui"
import { Icon } from "../components/icons"
import { AuthButton, AuthFeedback, AuthScreen } from "../components/auth-screen"
import { authStyles } from "../components/auth-styles"
import colors from "../theme.generated.json"

export default function EmailSignIn() {
  const [email, setEmail] = useState("")
  const [fieldError, setFieldError] = useState("")
  const [focused, setFocused] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const link = useMutation({ networkMode: "always", mutationFn: async (address: string) => {
    let callbackURL = Linking.createURL("/")
    if (process.env.EXPO_OS !== "web") {
      const state = Crypto.randomUUID()
      await SecureStore.setItemAsync("datool-inbox-email-state", JSON.stringify({ state, expires: Date.now() + 15 * 60_000 }))
      callbackURL = `datool-inbox://auth-callback?state=${state}`
    }
    const result = await auth.signIn.magicLink({ email: address, callbackURL })
    if (result.error) throw Object.assign(new Error(result.error.message || "We couldn’t send your sign-in link. Please try again."), { code: result.error.code, status: result.error.status })
  }, onSuccess: (_, address) => { Keyboard.dismiss(); setSentTo(address) }, onError: error => reportError("email_sign_in", error) })
  const submit = () => {
    if (link.isPending) return
    const address = (sentTo ?? email).trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setFieldError("Enter a valid email address.")
      input.current?.focus()
      return
    }
    setFieldError("")
    link.mutate(address)
  }
  return <AuthScreen form busy={link.isPending} onBack={() => router.canGoBack() ? router.back() : router.replace("/sign-in")}>
    {sentTo ? <>
      <View style={authStyles.story}>
        <View style={authStyles.sentIcon}><Icon name="mail" size={30} color={colors.selectionText} /></View>
        <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={authStyles.formTitle}>{"Check your\ninbox."}</Text>
        <Text style={authStyles.description}>We sent a sign-in link to</Text>
        <Text selectable style={authStyles.email}>{sentTo}</Text>
        <Text style={authStyles.description}>{process.env.EXPO_OS === "web" ? "Open the link in this browser to continue." : "Open the link on this phone to continue."} If it’s not there, check your spam folder.</Text>
      </View>
      <View style={authStyles.actions}>
        {link.error && <AuthFeedback error message={link.error.message} />}
        <AuthButton title={link.isPending ? "Sending link…" : "Resend sign-in link"} icon="mail" loading={link.isPending} onPress={submit} />
        <Pressable accessibilityRole="button" accessibilityLabel="Use a different email" accessibilityState={{ disabled: link.isPending }} disabled={link.isPending} style={({ pressed }) => [authStyles.textButton, pressed && authStyles.pressed]} onPress={() => { setSentTo(null); link.reset() }}><Text style={authStyles.textButtonLabel}>Use a different email</Text></Pressable>
      </View>
    </> : <>
      <View style={authStyles.story}>
        <Text accessibilityRole="header" style={authStyles.formTitle}>{"Your inbox\nis waiting."}</Text>
        <Text style={authStyles.description}>Enter your work email and we’ll send you a secure sign-in link. No password to remember.</Text>
      </View>
      <View style={authStyles.form}>
        <Text nativeID="email-label" style={authStyles.label}>Work email</Text>
        <Field ref={input} accessibilityLabel="Work email" accessibilityLabelledBy="email-label" aria-invalid={!!fieldError} placeholder="you@company.com" value={email} onChangeText={value => { setEmail(value); setFieldError(""); if (link.isError) link.reset() }} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress" returnKeyType="go" editable={!link.isPending} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onSubmitEditing={submit} style={[authStyles.input, focused && authStyles.inputFocused, !!fieldError && authStyles.inputInvalid]} />
        {!!fieldError && <Text selectable accessibilityRole="alert" style={authStyles.fieldError}>{fieldError}</Text>}
        {link.error && <AuthFeedback error message={link.error.message} />}
        <AuthButton title={link.isPending ? "Sending link…" : "Send sign-in link"} icon="arrow" loading={link.isPending} onPress={submit} />
      </View>
    </>}
    <Text style={authStyles.footer}>A little more human. A lot more helpful.</Text>
  </AuthScreen>
}
