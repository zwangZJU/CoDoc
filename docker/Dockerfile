# CoDoc 同写 · 应用镜像（基于 codoc:base，只放业务代码 + 前端构建）
# 基础镜像（codoc:base）已包含：系统包 + 前后端 node_modules
# 只有改了业务代码 / 前端才需要重建本层，npm ci 全部跳过
FROM codoc:base

WORKDIR /app

# ---- 前端构建（基于 base 里的 web/node_modules） ----
COPY web/ ./web/
COPY design-system/ ./design-system/
RUN cd /app/web && npm run build \
    && mkdir -p /usr/share/nginx/html \
    && rm -rf /usr/share/nginx/html/* \
    && cp -r /app/web/dist/* /usr/share/nginx/html/ \
    && rm -rf /app/web/node_modules /app/web/dist /app/web/package-lock.json

# ---- 后端源码（不含 node_modules 与 data） ----
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
RUN mkdir -p /app/server/data

# ---- 配置 ----
# Alpine nginx 主配置：http{} 内 include 的是 /etc/nginx/http.d/*.conf；
# conf.d 挂在顶层（不许有 server 块），必须放 http.d 才能写 server{}。
# 并删掉系统自带的 default_server（会抢先吃下 80 返回 404）。
RUN rm -f /etc/nginx/http.d/default.conf
COPY docker/nginx.conf /etc/nginx/http.d/codoc.conf
# 直接覆盖 supervisor 主配置（alpine 默认仅 include *.ini，覆盖最稳妥）
COPY docker/supervisord.conf /etc/supervisord.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:80/" >/dev/null 2>&1 || exit 1

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
