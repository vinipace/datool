import { Proza_Libre } from "next/font/google"

// The accent line shared by the home page (upright) and the agent landings (italic).
export const accentFont = Proza_Libre({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-landing-accent",
  display: "swap",
})
