"""设备管理系统 monitor 客户端 (maa agent 版)
====================================================

与 monitor.js (AutoX.js) 同协议接入设备管理服务器, 纯标准库实现:

  - POST /api/monitor/report  心跳/状态上报 (含 viewVar/editVarDev/configVarDev 三变量通道)
  - POST /api/monitor/vars    拉取服务端下发 (修改变量/配置变量) + editAck/configAck 确认闭环
  - 鉴权: TOTP(6位) + HMAC-SHA256 签名 + nonce 防重放, 与服务端 monitorVerifySigned 同源
  - 下发应用: 覆盖表 (线程安全) 供 main.py 挂钩读取, 数组 JSON 带「上次修改」时间戳锚点

设计原则: 任何网络/IO 失败一律静默降级, 绝不影响赠礼主流程;
后台 daemon 线程每 HEARTBEAT_SEC 秒一轮, 主线程只做无锁读查询。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
import threading
import time
import urllib.error
import urllib.request
import uuid as _uuid_mod
from datetime import datetime

# ==========================================================================
# 1. 配置 (可用 agent/mon_config.json 覆盖)
# ==========================================================================

AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(AGENT_DIR, "mon_config.json")
STATE_PATH = os.path.join(AGENT_DIR, "mon_state.json")

DEFAULTS = {
    "server": "https://2498755236.byethost7.com",
    # 与 monitor.js MON_UA 同源: byethost 免费空间对普通 UA 有 JS challenge, 该 UA 实测直通
    "ua": "Googlebot/2.1 (+http://www.google.com/bot.html)",
    "heartbeat_sec": 30,
    # TOTP seed 混淆存储 (XOR + Hex, 与 monitor.js MON_TOTP_MASKED/MON_TOTP_KEY 同源同值)
    "totp_masked": "1838623e023c7819085d7427012d740078387840662363097e32753d024f6f1c",
    "totp_key": "Mk7wQz9X",
    "ver": "maa-agent-1.0.0",
}


def _load_config() -> dict:
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            user = json.load(handle)
        if isinstance(user, dict):
            cfg.update({k: v for k, v in user.items() if v not in (None, "")})
    except (OSError, ValueError):
        pass
    return cfg


CFG = _load_config()

# ==========================================================================
# 2. 签名与身份
# ==========================================================================

_unmask_lock = threading.Lock()


def _unmask(hex_text: str, key: str) -> str:
    """种子混淆还原 (XOR + Hex, 抄自 monitor.js _unmask, 与 v2.js 同源)。"""
    if not hex_text or not key:
        return ""
    key_bytes = key.encode("utf-8")
    out = bytearray()
    for i in range(0, len(hex_text), 2):
        try:
            c = int(hex_text[i : i + 2], 16)
        except ValueError:
            return ""
        out.append(c ^ key_bytes[(i // 2) % len(key_bytes)])
    return out.decode("utf-8", errors="replace")


def _totp_seed() -> str:
    return _unmask(str(CFG.get("totp_masked", "")), str(CFG.get("totp_key", "")))


def _totp(seed: str, now_sec: int) -> str:
    """RFC 6238 标准 6 位动态码 (30s 窗口, HMAC-SHA1), 与 monitor.js _totp 同源。"""
    try:
        secret = base64.b32decode(seed + "=" * ((8 - len(seed) % 8) % 8), casefold=True)
    except Exception:
        return ""
    counter = int(now_sec // 30)
    digest = hmac.new(secret, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = (
        ((digest[offset] & 0x7F) << 24)
        | (digest[offset + 1] << 16)
        | (digest[offset + 2] << 8)
        | digest[offset + 3]
    )
    return f"{binary % 1000000:06d}"


def _hmac_sha256_hex(message: str, key: str) -> str:
    return hmac.new(
        key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _gen_nonce() -> str:
    return _uuid_mod.uuid4().hex[:16]


def _clean_device_id() -> str:
    """deviceId: model-serial 短串 (服务端清洗 [A-Za-z0-9_-.], <=64)。"""
    model, serial = "", ""
    for prop, slot in (("ro.product.model", "m"), ("ro.serialno", "s")):
        try:
            import subprocess

            out = subprocess.run(
                ["getprop", prop], capture_output=True, text=True, timeout=3
            ).stdout.strip()
            if out:
                if slot == "m":
                    model = out
                else:
                    serial = out
        except Exception:
            pass
    base = f"{model or 'maa'}-{(serial or identity_uuid()[:8]).lower()}"
    cleaned = "".join(c for c in base if c.isalnum() or c in "_-.")[:64]
    return cleaned or "maa-device"


def identity_uuid() -> str:
    """uuid: 32 位大写 hex, 首次生成落盘, 重启保持 (对齐 monitor.js uuid.dat)。"""
    global _UUID
    if _UUID:
        return _UUID
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as handle:
            state = json.load(handle)
        saved = str(state.get("uuid", "")).strip().upper()
        if len(saved) == 32:
            _UUID = saved
            return _UUID
    except (OSError, ValueError):
        pass
    _UUID = _uuid_mod.uuid4().hex.upper()
    _save_state({"uuid": _UUID})
    return _UUID


_UUID = ""
_DEVICE_ID = ""


def _save_state(patch: dict) -> None:
    state: dict = {}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            state = loaded
    except (OSError, ValueError):
        pass
    state.update(patch)
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=1)
    except OSError:
        pass


# ==========================================================================
# 3. HTTP (带签名)
# ==========================================================================

_NET_LOCK = threading.Lock()
_LAST_RT_MS = 0


def _signed_body() -> dict:
    now_sec = int(time.time())
    device_id = _DEVICE_ID or _clean_device_id()
    uuid = identity_uuid()
    nonce = _gen_nonce()
    totp = _totp(_totp_seed(), now_sec)
    message = (
        f"deviceId={device_id}&uuid={uuid}&nonce={nonce}"
        f"&timestamp={now_sec}&totp={totp}"
    )
    return {
        "deviceId": device_id,
        "uuid": uuid,
        "timestamp": now_sec,
        "nonce": nonce,
        "totp": totp,
        "sign": _hmac_sha256_hex(message, totp + _totp_seed()),
    }


def _post_json(path: str, payload: dict) -> dict:
    """POST JSON, 返回服务端 dict; 任何异常返回 {} (静默降级)。"""
    url = str(CFG["server"]).rstrip("/") + path
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": str(CFG.get("ua", "")),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        parsed = json.loads(body)
        return parsed if isinstance(parsed, dict) else {}
    except (urllib.error.URLError, OSError, ValueError):
        return {}


# ==========================================================================
# 4. 下发覆盖表 (main.py 挂钩读取)
# ==========================================================================

_OVR_LOCK = threading.Lock()
_OVR_EDIT: dict[str, str] = {}    # 修改变量通道下发的 name -> count
_OVR_CONFIG: dict[str, str] = {}  # 配置变量通道下发的 name -> count
_APPLIED = {"edit": "", "config": ""}  # ack 锚点 (数组「上次修改」时间戳 / 非数组 SHA256)
_VIEW: dict[str, object] = {}     # 查看变量 (只读运行摘要)


def _restore_state() -> None:
    global _APPLIED
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return
    uuid = str(state.get("uuid", "")).strip().upper()
    if len(uuid) == 32:
        globals()["_UUID"] = uuid
    for channel in ("edit", "config"):
        table = state.get(f"ovr_{channel}")
        if isinstance(table, dict):
            target = _OVR_EDIT if channel == "edit" else _OVR_CONFIG
            target.update(
                {str(k): str(v) for k, v in table.items() if k != "上次修改"}
            )
        applied = str(state.get(f"applied_{channel}", ""))
        if applied:
            _APPLIED[channel] = applied


def _persist_overrides() -> None:
    with _OVR_LOCK:
        snapshot = {
            "uuid": identity_uuid(),
            "ovr_edit": dict(_OVR_EDIT),
            "ovr_config": dict(_OVR_CONFIG),
            "applied_edit": _APPLIED["edit"],
            "applied_config": _APPLIED["config"],
        }
    _save_state(snapshot)


def override_params(params: dict) -> dict:
    """handle_gift_selection 挂钩: 服务端下发的动作配置项覆盖 interface.json 打包值。

    覆盖优先级: config 通道 > edit 通道 > custom_action_param 打包默认。
    """
    merged = dict(params)
    with _OVR_LOCK:
        for source in (_OVR_EDIT, _OVR_CONFIG):
            for key, value in source.items():
                if value != "":
                    merged[key] = value
    return merged


def floor_limit(default: int = 220) -> int:
    """层数上限 (CheckNumberAndStop 挂钩): 服务端 STOP_FLOOR 下发值优先。"""
    raw = override_params({}).get("STOP_FLOOR")
    try:
        return int(str(raw))
    except (TypeError, ValueError):
        return default


def should_stop() -> bool:
    """maa_cmd == 'stop' 时由动作入口调用 post_stop()。"""
    return str(override_params({}).get("maa_cmd", "")).strip().lower() == "stop"


# ==========================================================================
# 4b. 挂机时段 (条件类-时间段判断, 与 monitor.js timeRangeParse/timeInRange 同源)
# ==========================================================================


def _parse_range(value: object):
    """时间段字符串解析: "18:00-08:00"/"18-8"/"18:00-8"/含秒均可。

    全角 －/： 先转半角; 起终转分钟数; 无效返回 None; 起终相同视为零长度。
    """
    text = str(value if value is not None else "").strip()
    text = text.replace("－", "-").replace("：", ":")
    if not text:
        return None
    parts = text.split("-")
    if len(parts) != 2:
        return None

    def to_min(seg: str):
        seg = seg.strip()
        if not seg:
            return None
        pieces = seg.split(":")
        try:
            hour = int(pieces[0])
        except ValueError:
            return None
        if hour < 0 or hour > 23:
            return None
        minute = 0
        if len(pieces) > 1:
            try:
                minute = int(pieces[1])
            except ValueError:
                return None
            if minute < 0 or minute > 59:
                return None
        return hour * 60 + minute

    start = to_min(parts[0])
    end = to_min(parts[1])
    if start is None or end is None:
        return None
    return (start, end)


def _in_range(now_min: int, rng) -> bool:
    """当前分钟是否在时段内: 起<终同天内; 起>终跨天; 起终相同恒在外。"""
    if rng is None:
        return False
    start, end = rng
    if start == end:
        return False
    if start < end:
        return start <= now_min <= end
    return now_min >= start or now_min <= end


def actions_paused(now_min=None) -> bool:
    """挂机时段判定 (动作入口挂钩):

    「当前时间在 run_range 时段内」判定为 false (条目不存在/为空/格式无效/
    时段外, 一律 false) -> 返回 True (暂停全部动作, 只执行心跳);
    判定为 true -> 返回 False (正常执行)。
    """
    raw = override_params({}).get("run_range")
    rng = _parse_range(raw)
    if rng is None:
        return True
    if now_min is None:
        now = datetime.now()
        now_min = now.hour * 60 + now.minute
    return not _in_range(int(now_min), rng)


def note(**fields: object) -> None:
    """主流程挂钩: 更新查看变量只读摘要 (层数/任务/计数等)。"""
    with _OVR_LOCK:
        _VIEW.update(fields)


def _current_lists_json() -> str:
    """editVarDev/configVarDev 上报内容: 当前生效配置的数组 JSON (含「上次修改」)。"""
    with _OVR_LOCK:
        cfg_items = dict(_OVR_CONFIG)
    defaults = {
        "cat1_list": "吕布,马超,关羽,荀彧,王异,贾诩,司马懿,张春华,左慈,张角,章邯,龙且",
        "cat2_list": "范增,龙且,刘禅,萧何,马超,卫子夫,王异,周勃,曹丕,虞姬,樊哙,陈平,董卓,张梁,张骞",
        "cat3_list": "司马懿,鲁肃,孙尚香,袁术,姜维,刘禅,樊哙,子婴,扶苏,夏侯惇,张春华,曹植,步练师,华佗,吕雉,左慈,郭嘉,钟离眜,吕布,小乔",
        "cat4_list": "",
        "cat5_list": "武猛,陈胜,子敬,刘季",
        "cat6_list": "公瑾,仲谋,伯符,李广",
        "fallback_priority": "资助,驰援,并肩作战,武将牌",
        "STOP_FLOOR": "220",
        "maa_cmd": "",
        "run_range": "",
    }
    for key, value in defaults.items():
        cfg_items.setdefault(key, value)
    items = [{"name": k, "count": v} for k, v in cfg_items.items() if k != "上次修改"]
    items.append({"name": "上次修改", "count": ""})
    return json.dumps(items, ensure_ascii=False)


# ==========================================================================
# 5. 下发应用 + ack 闭环
# ==========================================================================


def _apply_channel(content: str, channel: str) -> bool:
    """应用一组下发内容, 返回是否成功 (成功才写 ack 锚点)。

    - 数组 JSON: name/count 逐条进覆盖表 (「上次修改」条目提取为锚点)
    - 非数组: 整体存覆盖表特殊键 _raw_{channel} (业务自用), 锚点取内容 SHA256
    与 monitor.js syncOne/arrApplyServerEdit 同源, 服务端按锚点停发同内容。
    """
    stamp = ""
    parsed = None
    try:
        candidate = json.loads(content)
        if isinstance(candidate, list):
            parsed = candidate
    except ValueError:
        parsed = None

    if parsed is not None:
        table: dict[str, str] = {}
        for item in parsed:
            if isinstance(item, dict) and "name" in item:
                name = str(item["name"])
                if name == "上次修改":
                    stamp = str(item.get("count", ""))
                    continue
                table[name] = str(item.get("count", "") if item.get("count") is not None else "")
        with _OVR_LOCK:
            target = _OVR_EDIT if channel == "edit" else _OVR_CONFIG
            target.clear()
            target.update(table)
    else:
        with _OVR_LOCK:
            target = _OVR_EDIT if channel == "edit" else _OVR_CONFIG
            target[f"_raw_{channel}"] = content
        stamp = hashlib.sha256(content.encode("utf-8")).hexdigest()

    _APPLIED[channel] = stamp
    _persist_overrides()
    return True


def _acks() -> tuple[str, str]:
    with _OVR_LOCK:
        return _APPLIED["edit"], _APPLIED["config"]


# ==========================================================================
# 6. 心跳循环
# ==========================================================================

_STARTED = False
_START_TIME = time.time()


def _heartbeat_once() -> None:
    t0 = time.time()
    body = _signed_body()
    if not body.get("sign"):
        return
    uptime = int(time.time() - _START_TIME)
    with _OVR_LOCK:
        view_snapshot = dict(_VIEW)
    view_items = [{"name": k, "count": v} for k, v in view_snapshot.items()]
    view_items.append({"name": "版本", "count": str(CFG.get("ver", ""))})
    view_items.append({"name": "运行秒", "count": uptime})
    view_items.append({"name": "上次心跳", "count": datetime.now().strftime("%H:%M:%S")})
    # 挂机时段状态: run_range 下发值 + 当前判定 (false=时段外, 动作已暂停)
    range_raw = str(override_params({}).get("run_range", "") or "")
    view_items.append({"name": "挂机时段", "count": range_raw})
    view_items.append(
        {"name": "动作状态", "count": "时段外暂停" if actions_paused() else "运行中"}
    )

    body.update(
        {
            "ver": str(CFG.get("ver", "")),
            "env": "maa",
            "uptimeSec": uptime,
            "note": str(view_snapshot.get("任务", "赠礼选择"))[:240],
            "floor": int(view_snapshot.get("层数", 0) or 0),
            "errorCount": int(view_snapshot.get("错误数", 0) or 0),
            "lastError": str(view_snapshot.get("最后错误", ""))[:240],
            "viewVar": json.dumps(view_items, ensure_ascii=False)[:65536],
            "editVarDev": _current_lists_json()[:65536],
        }
    )
    report = _post_json("/api/monitor/report", body)
    with _NET_LOCK:
        globals()["_LAST_RT_MS"] = int((time.time() - t0) * 1000)

    edit_ack, config_ack = _acks()
    vars_body = _signed_body()
    vars_body.update(
        {
            "editAck": edit_ack,
            "configAck": config_ack,
            "configVarDev": _current_lists_json()[:65536],
        }
    )
    result = _post_json("/api/monitor/vars", vars_body)
    if result.get("success"):
        for channel, key in (("edit", "edit"), ("config", "config")):
            content = str(result.get(key, "") or "")
            if content:
                try:
                    _apply_channel(content, channel)
                except Exception:
                    pass


def _loop() -> None:
    while True:
        try:
            _heartbeat_once()
        except Exception:
            pass
        time.sleep(max(10, int(CFG.get("heartbeat_sec", 30))))


def start() -> None:
    """启动后台心跳线程 (幂等, main 入口调用一次)。"""
    global _STARTED, _DEVICE_ID
    if _STARTED:
        return
    _STARTED = True
    _restore_state()
    _DEVICE_ID = _clean_device_id()
    thread = threading.Thread(target=_loop, name="mon-heartbeat", daemon=True)
    thread.start()
