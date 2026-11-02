# 想你 · 情侣小屋 —— 云端服务器镜像
# 构建: docker build -t xiangni .
# 运行: docker run -d --name xiangni -p 3000:3000 -v xiangni-data:/data xiangni
# （数据存在 /data/data.json 卷里，容器重建不丢）
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js index.html manifest.json icon-192.png icon-512.png ./

ENV DATA_FILE=/data/data.json
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]