import { webSearch } from "eve/tools/web_search"

// The model adapter admits this provider-executed tool only when the frozen
// agent configuration enables search. It uses the project's model credentials.
export default webSearch({ provider: "exa" })
