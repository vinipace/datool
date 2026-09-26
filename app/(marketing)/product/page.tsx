import { permanentRedirect } from "next/navigation"

export default function ProductPage() {
  permanentRedirect("/product/build")
}
