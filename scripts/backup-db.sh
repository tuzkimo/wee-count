#!/usr/bin/env bash
# 备份本仓库后端的 PostgreSQL，滚动保留最近 N 天。建议交给 cron 每天跑。
#
# 用法：~/wee-count/scripts/backup-db.sh
# 要改的只有下面「可调参数」那几行；默认值无需修改即可使用。
set -euo pipefail

# ====== 可调参数 ======
COMPOSE_DIR=$(cd "$(dirname "$0")/.." && pwd)/backend   # 后端目录；脚本放在仓库的 scripts/ 里就不用改
BACKUP_DIR=$HOME/backup/wee-count   # 备份存哪
KEEP_DAYS=7                         # 保留最近几天
PG_SERVICE=postgres                 # docker-compose.yml 里的数据库服务名
# =====================

mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"   # 备份里有用户名等数据，不给别人读
cd "$COMPOSE_DIR"

STAMP=$(date +%F)
TMP="$BACKUP_DIR/.wee-count-$STAMP.sql.gz.tmp"
OUT="$BACKUP_DIR/wee-count-$STAMP.sql.gz"

# 中途失败时清掉半成品，不让坏文件留在目录里冒充好备份
trap 'rm -f "$TMP"' EXIT

# 用户名和库名直接取容器里的环境变量，不用在这里重复填
docker compose exec -T "$PG_SERVICE" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$TMP"

# 两道检查：① 压缩包本身没坏 ② 里面确实是一份 pg_dump 输出
# （第二道防的是「dump 悄悄产出一个空文件」，那种备份最坑人）
if ! gzip -t "$TMP" || ! zcat "$TMP" | grep -c 'PostgreSQL database dump' > /dev/null; then
  echo "$(date '+%F %T') 备份自检失败：dump 不完整，已丢弃，未生成今天的备份" >&2
  exit 1
fi

mv "$TMP" "$OUT"
# +$((KEEP_DAYS-1)) 就是「保留 KEEP_DAYS 份」：删掉再早一天的
find "$BACKUP_DIR" -name 'wee-count-*.sql.gz' -type f -mtime "+$((KEEP_DAYS-1))" -delete

echo "$(date '+%F %T') OK $OUT $(du -h "$OUT" | cut -f1)"
