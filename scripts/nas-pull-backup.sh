#!/bin/sh
# 从服务器把 backup-db.sh 产出的备份拉到本机（NAS），滚动保留最近 N 天。
# 服务器和本机之间走内网（EasyTier 等），本脚本用 SSH 公钥免密登录。
#
# 用法：sudo /usr/local/bin/wee-count-pull-backup.sh
# 装好后先改下面「必须改」的两行，其余默认值不用动。

set -eu

# ====== 必须改 ======
SERVER=user@10.0.0.1                 # 服务器的 SSH 登录名@EasyTier 地址
BACKUP_DIR=/srv/backup/wee-count      # 备份存到本机哪个目录（必须是已挂载的数据盘目录）
# ====================

# ====== 按需改 ======
SSH_PORT=22                          # 服务器的 SSH 端口，不是 22 就改这里
TRANSFER=auto                        # 怎么把文件取回来：auto（推荐）/ rsync / tar
                                     # auto 会在两端都有 rsync 时用 rsync，否则自动改用 tar
# ====================

# ====== 一般不用改 ======
KEEP_DAYS=30                         # 本机保留最近几天
REMOTE_DIR=backup/wee-count          # 服务器上的备份位置，相对服务器的家目录；也可填绝对路径
SSH_KEY=/root/.ssh/wee_count_pull    # 本机登录服务器用的私钥
# =======================

if [ "$SERVER" = "user@10.0.0.1" ]; then
  echo "请先改脚本顶部的 SERVER（把 user@10.0.0.1 换成 用户名@服务器内网地址）" >&2
  exit 1
fi

# 目录必须已经存在：数据盘没挂载时直接失败，而不是悄悄把备份写到系统盘
[ -d "$BACKUP_DIR" ] || { echo "备份目录不存在，数据盘可能没挂载：$BACKUP_DIR" >&2; exit 1; }

ssh_q() {  # 带端口和密钥的 ssh；其余参数由调用处传进来
  ssh -p "$SSH_PORT" -i "$SSH_KEY" -o BatchMode=yes "$@"
}

if [ "$TRANSFER" = auto ]; then
  if command -v rsync > /dev/null 2>&1 && ssh_q "$SERVER" 'command -v rsync > /dev/null 2>&1'; then
    TRANSFER=rsync
  else
    TRANSFER=tar
  fi
fi
echo "$(date '+%F %T') 传输方式：$TRANSFER"

case "$TRANSFER" in
  rsync)
    # 故意不加 --delete：服务器只留自己那份天数，本机要留自己的份数
    rsync -az --no-perms --no-owner --no-group \
      -e "ssh -p $SSH_PORT -i $SSH_KEY -o BatchMode=yes" \
      "$SERVER:$REMOTE_DIR/" "$BACKUP_DIR/"
    ;;
  tar)
    # 退路：只用 ssh + tar（两端系统自带）。服务器没装 rsync 也能拉，代价是每次全量重传
    ssh_q "$SERVER" "tar -C '$REMOTE_DIR' -czf - ." | tar -xzf - -C "$BACKUP_DIR"
    ;;
  *)
    echo "TRANSFER 只能是 auto / rsync / tar，当前是：$TRANSFER" >&2
    exit 1
    ;;
esac

# 一份都没拉到就直接失败，不要打出「OK 本地共 0 份」这种假成功
if ! ls -1 "$BACKUP_DIR"/wee-count-*.sql.gz > /dev/null 2>&1; then
  echo "没拉到任何备份：确认服务器上已经跑过备份（backup-db.sh），且 REMOTE_DIR=$REMOTE_DIR 是对的" >&2
  exit 1
fi

find "$BACKUP_DIR" -name 'wee-count-*.sql.gz' -type f -mtime "+$((KEEP_DAYS-1))" -delete

echo "$(date '+%F %T') OK 本地共 $(ls -1 "$BACKUP_DIR" | wc -l) 份，最新：$(ls -t "$BACKUP_DIR" | head -1)"
