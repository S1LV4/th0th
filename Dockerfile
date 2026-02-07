# Usa imagem oficial do Bun
FROM oven/bun:1.2.0-alpine

# Instala dependências necessárias
RUN apk add --no-cache nodejs

WORKDIR /app

# Copia arquivos do projeto
COPY package.json bun.lock turbo.json tsconfig.json bunfig.toml ./
COPY packages ./packages
COPY apps ./apps

# Instala dependências
RUN bun install

# Variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PORT=3333

# Expõe a porta da API
EXPOSE 3333

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3333/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Comando para iniciar a API (usa bun diretamente)
WORKDIR /app/apps/tools-api
CMD ["bun", "run", "src/index.ts"]
