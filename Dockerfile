FROM node:22-alpine

RUN apk add --no-cache tzdata ca-certificates \
    && addgroup -S mail && adduser -S mail -G mail

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p data/logs data/tls data/dkim data/spool data/messages data/attachments data/tmp \
    && chown -R mail:mail /app

USER mail

EXPOSE 25 587 143 993 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/auth/register-config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.js"]
