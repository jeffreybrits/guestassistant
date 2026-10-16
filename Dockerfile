FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
EXPOSE 3456
CMD ["node", "server.js"]

