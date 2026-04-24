FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY newrelic.js index.js ./

EXPOSE 3001

CMD ["npm", "start"]
