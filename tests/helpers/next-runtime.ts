// Next captures AsyncLocalStorage when its request modules are initialized.
// Match its server bootstrap before test files load, independent of file order.
import "next/dist/server/node-environment-baseline"
