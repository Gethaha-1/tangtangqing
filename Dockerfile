# CloudBase 云托管镜像：容器 + CFS 持久化 SQLite
# node:sqlite 是 Node 22.13+ 内置，无需编译工具，也无需 better-sqlite3。
FROM node:22-bookworm-slim

WORKDIR /app

# 先装依赖（利用层缓存），再拷贝源码
COPY package.json package-lock.json ./
RUN npm install

COPY . .

# 云托管会用 CFS 挂载到 /data，这里先建好目录，避免运行时缺失
RUN mkdir -p /data

ENV NODE_ENV=production
# SQLite 库文件落在 CFS 上，容器重建后数据仍在
ENV TTQ_SQLITE_PATH=/data/tangtangqing.db

# prepare:ledger + next build
RUN npm run build

EXPOSE 3000

# CloudBase 云托管会注入 PORT，本地 docker run 也可 -e PORT=3000 覆盖
CMD ["sh", "-c", "next start -p ${PORT:-3000}"]
