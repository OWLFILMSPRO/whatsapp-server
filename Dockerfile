FROM node:20

WORKDIR /app

# Instala apenas o necessário (sem Chromium)
COPY package.json .
RUN npm install --production

COPY . .

# Expõe a porta do servidor
EXPOSE 3001

CMD ["node", "server.js"]
