FROM evoapicloud/evolution-api@sha256:456b4104b0ddffbb092d6b3c0560a4ae86fc3e014e885b882aca4b1b371dfc81
WORKDIR /opt/datool-baileys
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
RUN rm -rf /evolution/node_modules/baileys && ln -s /opt/datool-baileys/node_modules/baileys /evolution/node_modules/baileys
WORKDIR /evolution
COPY serialize-auth-events.cjs /tmp/serialize-auth-events.cjs
RUN node /tmp/serialize-auth-events.cjs && rm /tmp/serialize-auth-events.cjs
RUN node -e "const b=require('baileys'); if(typeof b.default!=='function'||typeof b.fetchLatestWaWebVersion!=='function'||typeof b.makeCacheableSignalKeyStore!=='function')process.exit(1);console.log('Evolution entry points compatible')"
LABEL org.datool.evolution.base="2.3.7" org.datool.evolution.baileys="7.0.0-rc14" org.datool.evolution.auth-events="credentials-first"
