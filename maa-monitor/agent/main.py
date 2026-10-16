"""
赠礼选择 Agent
==============

MaaFramework 自定义动作集合，负责「名将杀 · 千里走单骑」里赠礼面板的自动选择。

对外注册的自定义动作（名称与旧版完全一致，pipeline / interface 无需改名）：
    handle_gift_selection  —— 赠礼面板主流程（cat1 -> cat2 -> cat3 -> 兜底）
    reset_gift_state       —— 每局开始前清空「已领取」记录
    CheckNumberAndStop     —— 层数超阈值时停止任务（限制冲榜）
    ClearHitCountAction    —— 清空「节点中检测限制冲榜」的命中计数

六份 UI 名单（都由 interface.json 的「赠礼配置」传入，英文逗号分隔，只写武将名）：
    cat1_list   选这些武将 -> 优先拿信物
    cat2_list   选这些武将 -> 优先拿驰援
    cat3_list   选这些武将 -> 优先拿资助
    cat4_list   屏蔽这些武将拿信物
    cat5_list   屏蔽这些武将拿驰援
    cat6_list   屏蔽这些武将拿资助

    六者构成一条**总优先级链** cat1 > cat2 > cat3 > cat4 > cat5 > cat6：
    在赠礼面板上读出当前武将名后，链上第一个命中的名单决定一切。
    例：某武将同时在 cat1_list 和 cat6_list 里 -> 命中 cat1，cat6 完全失效。

本次重构相对旧版的变化：
    1. 状态集中到 ClaimState（单把 RLock），修掉旧版「cat2 特判处绕开锁」的竞态。
    2. 新增「兜底奖励优先级」可配置：UI 传入有序字符串（如
       "并肩作战,武将牌,驰援,资助"），越靠前越优先；底层靠 OCR 的
       order_by="Expected"（MaaFW v5.1+）实现。
    3. 各分支的奖励列表由 _reward_plan() 统一推导，消灭硬编码列表。
    4. 去掉 `for outer in range(1): ... continue` 的伪循环，改为顺序早退。
    5. OCR expected 为空时直接放弃，避免「匹配任意文字」造成误点。
    6. 魔法数字（延迟 / 重试 / ROI）全部常量化。
    7. 新增 cat3（资助）分支：与 cat1 / cat2 完全同构，排在 cat2 之后、
       兜底之前，且同样受 `not has_all(REQUIRED_CAT2)` 守卫。
    8. 新增 cat4 / cat5 / cat6 三份屏蔽名单：每次 _cug **之前**先在
       ROI_GIFT_GENERAL 上跑一次 _ban 识别（见 _read_display_name），按总优先级链
       命中屏蔽名单后，把对应奖励从本次 expected 里剃掉（见 _effective_expected）。

       _ban 节点的 expected 就是 **cat4 + cat5 + cat6 三份名单的并集**，
       action 显式写 DoNothing：MaaFW 会把不在 expected 里的 OCR 结果整个过滤掉，
       所以「返回了东西」本身就等价于「面板上这个武将是屏蔽名单里的人」——
       匹配交给 MaaFW 做，Python 只负责总优先级链的裁决。
       这次识别的结果**只用于判断、绝不参与点击** —— 要点的东西永远来自
       _cug 的 expected（纯奖励名），所以武将名在结构上不可能被点到。

       若屏蔽后待选奖励被剃成空列表 -> **退化为不屏蔽**，回退原始列表
       （赠礼面板是模态的，一个都不点会把流程卡住）。

       只有「expected 里含信物/驰援/资助」**且**「三份屏蔽名单非空」时才花这次
       OCR：没用这个功能的人零额外开销。
    9. 修掉 ClaimState._bucket() 对未知 category 静默回落到 cat1 的坑
       —— 加 cat3 桶时一旦漏写，cat3 的领取记录会污染 cat1 的判定。
   10. interface.json 的「赠礼配置」补齐 6 份名单 + fallback_priority 的接线
       （旧版 fallback_priority 建了 UI 输入却没传进 custom_action_param）。
   11. 新增「赠礼对照记录」（GiftLog）：每在「动态选择赠礼」里选中一个武将，
       就把「选择列表里点到的名字」和「详情页顶部标题」写进 赠礼记录.txt。

       为什么要记：选择列表显示的是武将的**名**（陆逊赠礼），
       点进去之后详情页标题显示的却是他的**字**（伯言赠礼）——
       同一场赠礼，两屏显示的是两个完全不同的字符串。
       只有把这一对记下来，才谈得上建「名 <-> 字」对照表。

       文件格式（一行一条，用「:」连接两栏、以「;」收尾）：
           陆逊赠礼:伯言赠礼;
           范增赠礼:亚父赠礼;
   12. 新增「赠礼记录模式」（UI 开关「是否自动采集赠礼对照」）：每次进赠礼面板前，
       把 赠礼记录.txt 与「所有武将」总名单做差集，用**还没记录过的武将**顶替
       UI 里的 cat1_list，从而在跑图过程中自动把没见过的武将喂进记录文件，
       逐步攒全「名 <-> 字」对照表。与原有信物名单冲突时**以改后的为准**
       （cat1 被完全覆盖，不是追加）。

       开关状态的传递路径（这里绕了一下，原因值得记着）：
       「选择赠礼」节点上的 set_gift_record_mode 动作 -> 模块级 RECORD_MODE
       -> handle_gift_selection 据此决定是否调 _with_record_mode()。

       为什么不直接把这个开关塞进「动态选择赠礼」的 custom_action_param？
       因为那个节点的 action 已被 interface 的「赠礼配置」override 覆盖，而
       pipeline_override 是**整体替换 action** 的（官方文档「资源覆盖」章 +
       实机 agent/debug/maafw.log 里 AgentServer 收到的最终 param 都证实了）。
       于是新增的开关必须把 type / custom_action / 全部 param 抄全，可 param 里
       那 7 个值都是「赠礼配置」的 input 占位符 —— 占位符替换按各 option
       **自己的 inputs** 做，开关没有 inputs，抄过去只会原样留下字面量
       "{cat1_list}"，比不生效更糟。挂到「选择赠礼」上则无任何约束：
       它的 param 里只有一个字面量 mode，也不与任何其它 option 抢同一个 action。

       其它行为：
       - 总名单优先读 agent/所有武将列表.txt（用户手维的源文件，改完即生效），
         读不到再退到 所有武将赠礼-逐行.txt / 所有武将赠礼-单行.txt
       - 判重时记录文件里「:」两侧都算：无论命中的是「名」还是「字」，
         都视为这个武将已经记录过，不会重复采集
       - 算出的列表另行落盘到 agent/待记录赠礼.txt，便于人工核对进度
       - 开关关闭 / 名单文件缺失 / 已全部记录完 -> 一律保留原 cat1_list，
         绝不把 cat1 清空（清了就永远进不了 cat1 分支）
       - 每次进面板都重算，所以刚记下一条就会立刻从列表里剔除，
         同一局内不会反复点同一个武将
   13. v3 流程重构 ——「流水线节点链 + next 自验证」（2026-10-02，按用户设计）。

       旧版把「选武将 -> 点奖励」全塞在 handle_gift_selection 一次 Python
       调用里跑完；v3 拆成 pipeline 节点链，每一步的 next 都包含它本身做
       自验证：完成了才走 next 的下一项 —— 网络卡顿（整页转圈、点击无效）
       由框架的 next 轮询自然消化
       （while(!hit && !timeout) { foreach(next); }，每轮重新截图）：

           选择赠礼(OCR 接受谁的，不变)
             -> 动态选择赠礼(handle_gift_selection 只装配：名单/优先级/状态复位)
                  next: [点击目标武将, 赠礼按钮兜底]        timeout 60s
             -> 点击目标武将(pick_general 识别图一底部那排，对回 cat1/2/3；Click)
                  next: [赠礼详情页, 属性变化, 点击目标武将(自身)] timeout 60s, post_delay 2000
                  —— 目的地优先（v3.4）：详情页标题一能识别到就直接走，
                     过渡帧里旧按钮残留在背景上也绝不补第二下；
                     标题不在 + 那排还在 = 点击无效/没跳转，重点
                  —— 属性变化兜底（v3.5）：万一详情页还是被补点掉、弹出
                     「武将技能」页，属性变化节点认出它并点掉，流程不死
             -> 赠礼详情页(OCR 标题「赠礼」= 确认进图二；gift_entered：
                cat1 在此领取 + 写「名:字」对照表，对应旧版 mark_claimed/GiftLog)
                  next: [选择目标奖励]                      timeout 60s
             -> 选择目标奖励(pick_reward：黑名单 -> 按优先级选奖励；Click)
                  next: [选择目标奖励(自身), 属性变化, 继续战斗]  timeout 60s, post_delay 1000
                  —— 点过的词还在 = 点击被吞，重点；
                     点过的词消失 = 领取生效（= 旧版「点到消失」），cat2/cat3 在此记账；
                     属性弹窗优先于 继续战斗（v3.2）
             -> 赠礼按钮兜底(cat1/2/3 全 miss 时走，OCR「XX赠礼」按钮；Click)
                  next: [赠礼详情页, 属性变化, 赠礼按钮兜底(自身)] timeout 60s, post_delay 2000
                  —— 目的地优先 + 属性变化兜底，同 点击目标武将（v3.4/v3.5）

       与旧版（最初代码）的对应关系：
       - select_general 的「OCR 名单 -> 点击」搬进 pick_general；点击后的
         跳转确认改由 next 的下一项（赠礼详情页标题）完成 —— 不再需要
         _detail_chk 之类的 Python 轮询
       - _ban 黑名单判定原样保留（_effective_expected，在图二标题上跑）
       - cat1 选中即领取（gift_entered）、cat2/cat3 点中主奖励才领取
         （= 旧版 _click_until_gone 返回 got 才 claim）、兜底不领取 —— 全部不变
       - 旧版 pick_fallback（点「赠礼」按钮）拆成独立的赠礼按钮兜底节点

       FLOW（极简跨节点状态，只有 5 个字段）：图一节点命中时 stage(分类, 名字)，
       图二节点读它决定主奖励与记账；每次进面板由 handle_gift_selection 复位。

   14. v3.3 —— 按用户要求整体移除「赠礼选择失败」错误处理（v3.1 方案下线）。

       v3.1 曾加过 fail_on_list / fail_on_detail 分流恢复 + FAIL_RETRY_MAX
       失败计数 + 重写版 handle_gift_fallback；用户确认节点链自带的
       next 自循环 + timeout 本身就是错误处理（点击无效 = 自循环重点，
       页面不在 = 落到后续节点收尾），该方案与「赠礼选择失败」节点一并
       移除，handle_gift_fallback 动作同步退役。
       「武将技能」事故的日志复盘留在第 15 条，其中去标题门禁、
       post_delay 防连点等修复仍然有效。

   15. v3.2 —— 2026-10-02 10:59:40 识别失败的日志复盘与修复。

       现场链路：赠礼按钮兜底自循环把「赠礼」按钮连点了两次（第 35.4s、
       36.3s，第二次落在正在打开的详情页上）-> 详情页标题位随后被
       「武将技能」子页签顶掉 -> pick_reward 的标题硬门禁连续 62 轮误判
       「不在图二」，奖励 OCR 一次都没跑 -> 白卡 60 秒 -> 失败处理
       （当时的旧版盲点实现也失败）-> 外层错误处理直接退了房间。

       修复（对应三处）：
       a) pick_reward 去掉标题硬门禁（见 7 节类注释，回到最初代码行为）；
       b) 选择目标奖励 post_delay=1000 + next 调为 [自身, 属性变化, 继续战斗]
          （用户要求：领取后属性弹窗网络慢时约 1 秒才出现，先等再优先认它，
          防止继续战斗抢跑）；
       c) 点击目标武将 / 赠礼按钮兜底 post_delay：自循环重试前留出
          页面过渡时间，消灭「旧帧上还在的按钮被再点一下」的连点问题
          （本次「武将技能」页就是第二下点出来的；v3.2=800 -> v3.4=1000
          -> v3.5=2000，逐版加大）。

   16. v3.4 —— 跳转类节点 next 改为「目的地优先」（2026-10-03，用户反馈）。

       现象：网络正常时，点击目标武将 / 赠礼按钮兜底 仍会点两下 ——
       点击生效后详情页正在弹出，过渡帧里旧按钮残留在背景上还能被识别，
       而 next 原来是自身优先 -> 同一轮先命中自身 -> 补了第二下，
       把刚弹出的赠礼详情点掉。

       修复：点击目标武将.next = [赠礼详情页, 自身]、
             赠礼按钮兜底.next = [赠礼详情页, 自身]，
       并把两处 post_delay 800 -> 1000（过渡多留余量）。
       目的地一能识别到就直接走，永远不会再朝它补点；
       「点击被吞」的场景不受影响（标题不在才会轮到自身重点）。
       注意：选择目标奖励保持自身优先 —— 「点到消失」语义需要对着
       已点过的词重试，与跳转类节点不同。

   17. v3.5 —— 目的地优先仍不够时的双保险（2026-10-04，用户反馈）。

       用户实测 v3.4 后双击仍偶发（post_delay 可能没生效或过渡超过 1s），
       给出两条指示：①再加延时；②在跳转类节点 next 里加「属性变化」，
       就算详情页被点掉也能继续运行。两条都落地：

       a) 点击目标武将 / 赠礼按钮兜底 post_delay 1000 -> 2000；
       b) 两节点 next 中间插入属性变化：
          next = [赠礼详情页, 属性变化, 自身]。
          属性变化节点（定义于 继续挑战.json）OCR「武将技能」
          @roi[563,114,143,60] -> 点击底部确认区，其 next 含继续战斗，
          正好接住「详情页被第二下点掉/武将技能页弹出」的最坏情况 ——
          这一轮赠礼作废，但流程被接住继续跑，不再卡死。
       排序说明：赠礼详情页仍在属性变化之前 —— 正常详情页标题是
       「XX赠礼」，只有被点掉后才可能出现「武将技能」，两者本来互斥，
       放前面只是防御性保证先走正常路径。
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from datetime import datetime
from typing import Any, Iterable, Sequence

from maa.agent.agent_server import AgentServer
from maa.context import Context
from maa.custom_action import CustomAction
from maa.custom_recognition import CustomRecognition
from maa.pipeline import JOCR, JRecognitionType
from maa.tasker import Tasker

# ==========================================================================
# 1. 默认配置
# ==========================================================================

CAT1_DEFAULT: list[str] = [
    "吕布赠礼",
    "马超赠礼",
    "关羽赠礼",
    "张春华赠礼",
    "司马懿赠礼",
    "孙策赠礼",
]

CAT2_DEFAULT: list[str] = [
    "范增赠礼",
    "龙且赠礼",
    "刘禅赠礼",
    "萧何赠礼",
    "马超赠礼",
    "周勃赠礼",
    "曹丕赠礼",
    "虞姬赠礼",
    "樊哙赠礼",
]

# cat3（资助）默认不开，交给 UI 自己填；为空时 cat3 分支会被直接跳过
CAT3_DEFAULT: list[str] = []

# 三份「屏蔽」名单默认全空 = 不屏蔽任何武将
CAT4_DEFAULT: list[str] = []  # 屏蔽信物
CAT5_DEFAULT: list[str] = []  # 屏蔽驰援
CAT6_DEFAULT: list[str] = []  # 屏蔽资助

# 必须优先集齐的 cat2 武将：拿齐后不再走 cat1/cat2/cat3 分支，直接进入兜底分支
REQUIRED_CAT2: frozenset[str] = frozenset(
    {"范增赠礼", "龙且赠礼", "刘禅赠礼", "萧何赠礼"}
)

# cat2 互斥规则：{后置武将: 前置武将} —— 前置没拿到前先排除后置
CAT2_MUTEX: dict[str, str] = {"龙且赠礼": "范增赠礼"}

# 各分支的专属奖励目标
CAT1_REWARD = "信物"
CAT2_REWARD = "驰援"
CAT3_REWARD = "资助"

# 总优先级链：链上第一个命中的名单决定一切（见模块 docstring）
CAT_CHAIN: tuple[str, ...] = ("cat1", "cat2", "cat3", "cat4", "cat5", "cat6")

# 各「屏蔽」名单对应的奖励：命中即从本次待选奖励列表里剔掉
CAT_BAN_REWARDS: dict[str, tuple[str, ...]] = {
    "cat4": (CAT1_REWARD,),  # 屏蔽信物
    "cat5": (CAT2_REWARD,),  # 屏蔽驰援
    "cat6": (CAT3_REWARD,),  # 屏蔽资助
}

# 有可能被屏蔽的奖励全集 —— expected 里一个都没有时，整段屏蔽判定直接跳过（省一次 OCR）
BANNABLE_REWARDS: frozenset[str] = frozenset(
    reward for rewards in CAT_BAN_REWARDS.values() for reward in rewards
)

# 各追踪名单的默认值（cat3 为空 = 默认不启用资助分支）
CAT_DEFAULT: dict[str, list[str]] = {
    "cat1": CAT1_DEFAULT,
    "cat2": CAT2_DEFAULT,
    "cat3": CAT3_DEFAULT,
}

# 兜底奖励默认优先级（UI 可用 fallback_priority 覆盖；列表顺序即优先级）
DEFAULT_REWARD_PRIORITY: list[str] = ["并肩作战", "武将牌", "驰援", "资助"]

# ROI：[x, y, w, h]（1280x720 基准，与实机截图一致）
ROI_GENERAL_LIST = [127, 495, 1035, 79]   # 「请选择接受谁的赠礼？」三个按钮整行（图一）
ROI_REWARD_PANEL = [522, 171, 171, 377]   # 奖励面板（_cug 的识别区，只放奖励）
ROI_GIFT_GENERAL = [580, 104, 201, 55]    # 赠礼详情页顶部标题，形如「伯言赠礼」（图二）
ROI_GIFT_BUTTON = [531, 504, 220, 51]     # 「赠礼」按钮
ROI_FLOOR = [239, 45, 42, 49]             # 左上角层数

# agent/ 目录（main() 已把 cwd 切到这里，所有数据文件都落在这里）
_AGENT_DIR = os.path.dirname(os.path.abspath(__file__))

# 赠礼对照记录文件
GIFT_LOG_PATH = os.path.join(_AGENT_DIR, "赠礼记录.txt")

# 「所有武将」名单文件：按顺序探测，取第一个存在的。
# 源文件（所有武将列表.txt）优先 —— 它由用户手工维护，改完立刻生效，
# 不必重新生成；后两个是之前生成的「XX赠礼」派生产物，作为兜底。
GIFT_ROSTER_CANDIDATES: tuple[str, ...] = (
    "所有武将列表.txt"
)

# 记录模式下算出的「待记录名单」落盘位置（每次重算时覆盖，纯给人看的）
GIFT_TODO_PATH = os.path.join(_AGENT_DIR, "待记录赠礼.txt")

# agent 自己的日志文件。
# _log 除了 print（进 maafw.log / MFA 的输出窗），还会追加到这里 ——
# 这样排查「屏蔽到底有没有生效」这类问题时不必在几十 MB 的 maafw.log 里捞。
AGENT_LOG_PATH = os.path.join(_AGENT_DIR, "agent日志.txt")

# 当前是否处于「赠礼记录模式」。
# 由 pipeline 节点「选择赠礼」上的 set_gift_record_mode 动作每次进赠礼面板前写入，
# 所以它总是最新值 —— 不需要在任何地方复位。
RECORD_MODE: bool = False

# 时间 / 重试参数
CLICK_DELAY = 0.2
MAX_RETRY = 3
GENERAL_SCAN_ROUNDS = 2
GENERAL_SCAN_INTERVAL = 0.5
POLL_TIMEOUT = 3.0
POLL_INTERVAL = 0.2
STOP_FLOOR = 220

# ==========================================================================
# 2. 日志
# ==========================================================================


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# 日志文件句柄（惰性打开）与它的锁。
# 用 RLock：_log 可能在 select_general / _cug 等多个线程里被调用。
_LOG_LOCK = threading.RLock()
_LOG_FILE: Any = None
_LOG_FILE_FAILED = False


def _log_file():
    """惰性打开日志文件；打不开（只读目录等）就永久退回"只 print"。"""
    global _LOG_FILE, _LOG_FILE_FAILED
    if _LOG_FILE is not None or _LOG_FILE_FAILED:
        return _LOG_FILE
    try:
        _LOG_FILE = open(AGENT_LOG_PATH, "a", encoding="utf-8", buffering=1)
    except OSError:
        _LOG_FILE_FAILED = True
        _LOG_FILE = None
    return _LOG_FILE


def _log(tag: str, message: str) -> None:
    line = f"[{_now()}] [{tag}] {message}"
    print(line, flush=True)
    with _LOG_LOCK:
        handle = _log_file()
        if handle is not None:
            try:
                handle.write(line + "\n")
                handle.flush()
            except (OSError, ValueError):
                # 写失败不影响主流程 —— 日志只是辅助，绝不能让脚本因此停摆
                pass


# ==========================================================================
# 3. 参数解析
# ==========================================================================


def _parse_params(raw: Any) -> dict[str, Any]:
    """把 custom_action_param 统一解析成 dict。

    MaaFW 在节点没写 custom_action_param 时可能传 None、空串或字面量 "null"，
    这里统一兜底成空 dict，避免调用方到处判空。
    """
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text or text == "null":
            return {}
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            _log("GiftAgent", f"custom_action_param 解析失败: {exc}")
            return {}
        return data if isinstance(data, dict) else {}
    return {}


def _parse_priority(raw: Any, default: Sequence[str]) -> list[str]:
    """解析 UI 传来的奖励优先级字符串，如 "并肩作战,武将牌,驰援,资助"。

    - 兼容中英文逗号
    - 去空白、去重，保证顺序不乱
    - 解析结果为空时回落到 default
    """
    if not raw or not isinstance(raw, str):
        return list(default)

    items: list[str] = []
    for chunk in raw.replace("，", ",").split(","):
        name = chunk.strip()
        if name and name not in items:
            items.append(name)
    return items or list(default)


def _split_names(raw: Any) -> list[str]:
    """把 UI 传来的名单字符串 "吕布,马超" 拆成 ["吕布", "马超"]。

    - 兼容中英文逗号
    - 去空白、保序去重
    """
    if not raw or not isinstance(raw, str):
        return []

    items: list[str] = []
    for chunk in raw.replace("，", ",").split(","):
        name = chunk.strip()
        if name and name not in items:
            items.append(name)
    return items


def _normalize_name(raw: Any) -> str:
    """归一化武将名：去掉空白和「赠礼」。

    UI 里填的是「吕布」这种裸名字，而赠礼面板上显示的是「吕布赠礼」，
    两边都过一遍这个函数才能直接比。
    """
    if not raw or not isinstance(raw, str):
        return ""
    return raw.replace(" ", "").replace("\u3000", "").replace("赠礼", "")


def _dedupe(items: Iterable[str]) -> list[str]:
    """保序去重。"""
    seen: list[str] = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


_TRUTHY: frozenset[str] = frozenset(
    {"true", "1", "yes", "y", "on", "是", "开", "开启", "启用"}
)


def _as_bool(raw: Any) -> bool:
    """把 UI 传来的开关值解析成 bool。

    MaaFW 的 custom_action_param 经字符串占位符替换后全是字符串，
    所以 "true" / "false" 这两种字面量是主要形态；这里顺带兼容中英文各种写法，
    避免用户手改 interface.json 时写 "是"/"Y" 被判成 False。
    解析不了的按 False 处理 —— 记录模式默认关，出错时行为退回旧版最安全。
    """
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return raw != 0
    if isinstance(raw, str):
        return raw.strip().lower() in _TRUTHY
    return False


# ==========================================================================
# 4. 全局状态（线程安全）
# ==========================================================================


class ClaimState:
    """「已领取武将」记录。

    旧版对 cat1 / cat2 各用一把锁，但 _get_active_list 里对 cat2 的特判
    段落没有进锁，存在竞态。这里统一成一把 RLock，所有读写都走方法，
    从结构上杜绝漏锁。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._buckets: dict[str, set[str]] = {
            "cat1": set(),
            "cat2": set(),
            "cat3": set(),
        }

    def _bucket(self, category: str) -> set[str]:
        # 旧版是 .get(category, cat1)：未知 category 会**静默**写进 cat1 的桶，
        # 加 cat3 时一旦漏建桶就会污染 cat1 的 pending 判定且不报错。
        # 改成自动建桶，永远不会有桶缺失。
        return self._buckets.setdefault(category, set())

    def claim(self, category: str, name: str) -> None:
        with self._lock:
            self._bucket(category).add(name)

    def reset(self) -> None:
        with self._lock:
            for bucket in self._buckets.values():
                bucket.clear()

    def snapshot(self, category: str) -> set[str]:
        with self._lock:
            return set(self._bucket(category))

    def pending(self, full: Sequence[str], category: str) -> list[str]:
        """返回 full 中尚未领取的武将（加锁读取）。"""
        with self._lock:
            claimed = self._bucket(category)
            return [name for name in full if name not in claimed]

    def has_all(self, names: Iterable[str]) -> bool:
        with self._lock:
            return set(names).issubset(self._buckets["cat2"])


STATE = ClaimState()


class _FlowState:
    """一次赠礼事件内、跨 pipeline 节点共享的极简状态（v3 节点链的粘合层）。

    「选武将」在图一节点（pick_general），「选奖励」在图二节点（pick_reward），
    两者分属不同 pipeline 节点 —— 图二必须知道图一选中的是谁、属于哪个分支，
    才能决定「优先拿信物/驰援/资助」。只有 4 个字段：

        category     图一命中的分支（"cat1"/"cat2"/"cat3"；兜底路径为 None）
        name         图一 OCR 到的武将按钮文本（如「左慈赠礼」，记账/对照表用）
        clicked_word pick_reward 最近一次点中的奖励词（判定「点到消失」用）
        done         奖励阶段是否已收尾（收尾后 pick_reward 恒返回未命中）

    生命周期：handle_gift_selection（动态选择赠礼）每次进面板时 reset；
    pick_general 命中时 stage；gift_entered（确认进图二）领 cat1；
    pick_reward 检测「点到消失」时给 cat2/cat3 记账并收尾。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._reset_locked()

    def _reset_locked(self) -> None:
        self.category: str | None = None
        self.name = ""
        self.clicked_word = ""
        self.done = False

    def reset(self) -> None:
        with self._lock:
            self._reset_locked()

    def stage(self, category: str, name: str) -> None:
        with self._lock:
            self.category = category
            self.name = name

    def note_click(self, word: str) -> None:
        with self._lock:
            self.clicked_word = word

    def finish(self) -> None:
        """奖励阶段收尾（点到消失 / 放弃），之后 pick_reward 恒返回未命中。"""
        with self._lock:
            self.done = True

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "category": self.category,
                "name": self.name,
                "clicked_word": self.clicked_word,
                "done": self.done,
            }


FLOW = _FlowState()

# ==========================================================================
# 5. 屏幕原语
# ==========================================================================


def _screencap(context: Context):
    """截图并返回图像，失败时返回 None。"""
    context.tasker.controller.post_screencap().wait()
    try:
        return context.tasker.controller.cached_image
    except RuntimeError:
        return None


def _ocr(context: Context, image, name: str, roi, expected, order_by: str = "Expected"):
    """在给定图像上做一次 OCR，返回排序后的第一个结果。

    - image 为空 / 尺寸为 0 / expected 为空 -> 直接返回 None
      （expected 为空时 MaaFW 会匹配屏幕上任意文字，必须挡掉）
    - order_by="Expected"（MaaFW v5.1+）会按 expected 列表顺序排序，
      因此「expected 的顺序 = 优先级」。
    - 返回值只可能是 expected 里出现过的文字 —— MaaFW 会把不在 expected 里的
      结果整个过滤掉。屏蔽环节正是靠这一点保证「武将名永远不会被点到」。
    """
    if image is None or getattr(image, "size", 0) == 0 or not expected:
        return None

    reco = context.run_recognition(
        name,
        image,
        {
            name: {
                "recognition": "OCR",
                "roi": roi,
                "expected": list(expected),
                "order_by": order_by,
            }
        },
    )
    return reco.best_result if reco and reco.hit and reco.best_result else None


def _ocr_snap(context: Context, name: str, roi, expected, order_by: str = "Expected"):
    """先截图再 OCR。"""
    return _ocr(context, _screencap(context), name, roi, expected, order_by)


def _click(context: Context, box) -> None:
    """点击 box 的中心点。"""
    cx = box[0] + box[2] // 2
    cy = box[1] + box[3] // 2
    context.tasker.controller.post_click(cx, cy).wait()


def _poll_ocr(
    context: Context,
    roi,
    expected,
    timeout: float = POLL_TIMEOUT,
    interval: float = POLL_INTERVAL,
    apply_bans: bool = True,
):
    """轮询等待目标出现，超时返回 None（同样先过一遍屏蔽名单）。"""
    if apply_bans:
        expected = _effective_expected(context, expected)

    deadline = time.time() + timeout
    while time.time() < deadline:
        result = _ocr_snap(context, "_poll", roi, expected)
        if result:
            return result
        time.sleep(interval)
    return None


def _read_gift_title(context: Context, timeout: float = POLL_TIMEOUT) -> str:
    """读赠礼详情页顶部的标题（形如「伯言赠礼」），读不到返回空串。

    和 _read_display_name 读的是同一个 ROI_GIFT_GENERAL，但用途完全不同：
    那个是「这个武将在不在屏蔽名单里」，这里是「把标题原样抄下来」。

    expected 只写「赠礼」两个字 —— MaaFW 的 expected 是子串（正则 search）
    语义，所以这一条能把整行标题捞出来，不需要事先知道任何一个武将的名或字。
    每 POLL_INTERVAL 重试一次，等详情页的进场动画播完。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = _ocr_snap(context, "_gift_title", ROI_GIFT_GENERAL, ["赠礼"])
        if result:
            text = (result.text or "").strip()
            if text:
                return text
        time.sleep(POLL_INTERVAL)
    return ""


# ==========================================================================
# 5.5 屏蔽名单（cat4 / cat5 / cat6）
# ==========================================================================


class GiftConfig:
    """本次 custom_action 调用带入的配置：兜底优先级 + 六份名单。

    和 STATE 一样是模块级单例，由每个 custom_action 开头调 load() 刷新，
    这样 _click_until_gone / _poll_ocr 这些底层原语不用多传一堆参数。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.priority: list[str] = list(DEFAULT_REWARD_PRIORITY)
        self.lists: dict[str, str] = {cat: "" for cat in CAT_CHAIN}
        self._names: dict[str, list[str]] = {cat: [] for cat in CAT_CHAIN}
        # 上一次打过日志的屏蔽名单，用来避免重复刷同一行
        self._last_bans_logged: dict[str, list[str]] = {}

    def load(self, params: dict[str, Any]) -> None:
        """从 custom_action_param 读入 6 份名单 + 兜底优先级。"""
        lists = {
            cat: str(params.get(f"{cat}_list", "") or "") for cat in CAT_CHAIN
        }
        priority = _parse_priority(
            params.get("fallback_priority", ""), DEFAULT_REWARD_PRIORITY
        )
        # 比对用的名字统一归一化，这样 UI 填「吕布」能对上面板上的「吕布赠礼」
        names = {
            cat: [n for n in (_normalize_name(x) for x in _split_names(text)) if n]
            for cat, text in lists.items()
        }

        with self._lock:
            self.priority = priority
            self.lists = lists
            self._names = names

        # 每次 custom_action 都 load 一次（参数可能被 UI 改过），
        # 所以只在屏蔽名单有变化时打日志，避免每进一次面板刷一行。
        bans = {cat: names[cat] for cat in CAT_BAN_REWARDS if names[cat]}
        if bans != self._last_bans_logged:
            self._last_bans_logged = bans
            if bans:
                _log(
                    "Shield",
                    "屏蔽名单已加载："
                    + "; ".join(f"{cat}={names}" for cat, names in bans.items()),
                )
            else:
                _log("Shield", "屏蔽名单已清空（cat4/5/6 全空）")

    def has_bans(self) -> bool:
        """三份屏蔽名单里只要有一份非空就返回 True。

        全空 = 用户根本没用这个功能 -> 连那一次判定 OCR 都不用做，0 开销。
        """
        with self._lock:
            return any(self._names[cat] for cat in CAT_BAN_REWARDS)

    def ban_names(self) -> list[str]:
        """cat4 + cat5 + cat6 三份名单的并集（已归一化），喂给 _ban 的 expected。

        - 顺序按 CAT_BAN_REWARDS 的键序（cat4 -> cat5 -> cat6）并去重
        - expected 是「或」关系、且支持正则，所以只要面板武将名里含其中任意一个
          就算命中；UI 里填「吕布」能对上「吕布赠礼」，填「吕布赠礼」也行
        """
        with self._lock:
            names: list[str] = []
            for cat in CAT_BAN_REWARDS:
                for name in self._names[cat]:
                    if name and name not in names:
                        names.append(name)
            return names

    def banned_rewards(self, who: str) -> set[str]:
        """按总优先级链判定：当前武将 who 本次不得选哪些奖励。

        链上第一个命中的名单决定一切 —— 先命中 cat1/cat2/cat3 就直接返回空集
        （它们的屏蔽名单完全失效），只有前三个都没命中才轮到 cat4/5/6。
        """
        who = _normalize_name(who)
        if not who:
            return set()

        with self._lock:
            chain = [(cat, list(self._names[cat])) for cat in CAT_CHAIN]

        for cat, names in chain:
            if any(name in who for name in names):
                banned = set(CAT_BAN_REWARDS.get(cat, ()))
                if banned:
                    _log("Shield", f"面板武将「{who}」命中 {cat} -> 屏蔽 {sorted(banned)}")
                else:
                    _log("Shield", f"面板武将「{who}」命中 {cat} -> 该分支无屏蔽项")
                return banned
        return set()


CONFIG = GiftConfig()


def _ocr_all_texts(reco: Any) -> list[str]:
    """从一次识别结果里捞出**全部** OCR 文本（不是只有命中的那些）。

    命中时用 filtered_results（过滤后的），没命中时 filtered 为空 ——
    但 detail.all 里仍然有原始识别结果，正是排查「为什么没对上」要看的。
    """
    texts: list[str] = []
    for attr in ("filtered_results",):
        for result in list(getattr(reco, attr, None) or []):
            text = getattr(result, "text", "")
            if text and text not in texts:
                texts.append(text)
    if texts:
        return texts
    # filtered 为空 -> 退回原始结果（detail.all / all_results / best_result 三种形态都试）
    for attr in ("all_results", "detail"):
        raw = getattr(reco, attr, None)
        if isinstance(raw, dict):
            for result in list(raw.get("all") or []):
                text = getattr(result, "text", "") or (result.get("text", "") if isinstance(result, dict) else "")
                if text and text not in texts:
                    texts.append(text)
        elif raw:
            for result in list(raw):
                text = getattr(result, "text", "")
                if text and text not in texts:
                    texts.append(text)
    if not texts:
        best = getattr(reco, "best_result", None)
        if best is not None and getattr(best, "text", ""):
            texts.append(best.text)
    return texts


def _read_display_name(context: Context) -> str:
    """判断 ROI_GIFT_GENERAL 上显示的武将是否踩中屏蔽名单（cat4 / cat5 / cat6）。

    返回 OCR 读到的武将名（形如「公孙瓒赠礼」）= 踩中了；返回空串 = 没踩中。

    expected 就是 **cat4 + cat5 + cat6 三份名单的并集**，节点 action 显式写
    DoNothing。MaaFW 会把不在 expected 里的 OCR 结果整个过滤掉，所以
    「有没有返回结果」本身就直接表达了「这个武将在不在屏蔽名单里」——
    匹配由 MaaFW 完成，Python 侧只做总优先级链的裁决（见 banned_rewards）。

    ⚠ 结果**只用于判断，绝不参与点击**：点击方永远是 _cug，其 expected 里
    只有奖励名；这里又走的是 run_recognition（只识别、不执行动作），
    节点 action 还是 DoNothing —— 三重保证武将名点不到。
    """
    ban_names = CONFIG.ban_names()
    if not ban_names:
        # 三份屏蔽名单全空 —— 这属于「没用这个功能」，不是异常，只在 debug 级别提一句
        _log("Shield", "屏蔽名单为空，本次不做屏蔽判定")
        return ""

    image = _screencap(context)
    if image is None or getattr(image, "size", 0) == 0:
        _log("Shield", "警告：截图失败/为空，本次屏蔽判定跳过")
        return ""

    reco = context.run_recognition(
        "_ban",
        image,
        {
            "_ban": {
                "recognition": "OCR",
                "roi": ROI_GIFT_GENERAL,
                "expected": ban_names,
                "action": "DoNothing",
                "order_by": "Expected",
            }
        },
    )
    if not (reco and reco.hit):
        # ★ 最关键的一条日志：没命中时把「面板上实际读到什么」打出来。
        # 屏蔽名单填的是武将的**名**（吕布），而详情页标题写的是**字**（奉先），
        # 子串匹配天然对不上 —— 不打印实际文本的话，这种情况表现为
        # 「名单配了但永远不生效」，而且毫无线索。
        raw = _ocr_all_texts(reco)
        if raw:
            _log(
                "Shield",
                f"未命中屏蔽名单（expected={ban_names}）"
                f"，面板实际为「{'/'.join(raw)}」",
            )
        else:
            _log("Shield", f"未命中屏蔽名单（expected={ban_names}），且未读到任何文本")
        return ""

    texts = _ocr_all_texts(reco)
    text = "".join(texts)
    if text:
        _log(
            "Shield",
            f"面板武将「{text}」踩中屏蔽名单（expected={ban_names}）",
        )
    return text


def _effective_expected(context: Context, expected: Sequence[str]) -> list[str]:
    """在 _cug 之前，按屏蔽名单把本次不许选的奖励从 expected 里剃掉。

    只在「确实有东西可屏蔽」时才花这一次识别：

    - expected 里没有 信物/驰援/资助   -> 直接返回（例：pick_fallback 的 ["赠礼"]）
    - cat4/cat5/cat6 三份名单全空       -> 直接返回（不用这功能的人 0 开销）
    - _ban 没匹配上（武将不在屏蔽名单）-> 原样返回（绝大多数情况走这里）
    - 匹配上了但总优先级链里 cat1/2/3 先命中 -> 原样返回（屏蔽失效，符合链语义）
    - 剃完变成空列表 -> 退化为不屏蔽，回退原始列表（面板模态，不能不点）
    """
    expected = list(expected)

    if not any(reward in BANNABLE_REWARDS for reward in expected):
        # 待选里压根没有「信物/驰援/资助」——屏蔽这三分支管不着，省掉一次 OCR
        _log("Shield", f"本次待选 {expected} 无信物/驰援/资助，跳过屏蔽判定")
        return expected
    if not CONFIG.has_bans():
        # cat4/cat5/cat6 全空。这条**每次都打**：它就是「屏蔽功能开了没」的开关证据，
        # 少了它，用户会怀疑「我明明填了名单为什么不生效」，其实名单一次都没传进来。
        _log("Shield", f"cat4/5/6 三份屏蔽名单均为空，本次不屏蔽（待选 {expected}）")
        return expected

    _log(
        "Shield",
        f"开始屏蔽判定：待选 {expected}，屏蔽名单 {CONFIG.ban_names()}",
    )

    who = _read_display_name(context)
    if not who:
        return expected

    banned = CONFIG.banned_rewards(who)
    if not banned:
        # 踩中了屏蔽名单，但总优先级链上 cat1/2/3 先命中 -> 屏蔽按语义失效
        _log("Shield", f"「{who}」在屏蔽名单里，但优先级链更靠前的名单先命中，本次不屏蔽")
        return expected

    kept = [reward for reward in expected if reward not in banned]
    if not kept:
        # 剃光了。赠礼面板是模态的，一个都不点会把流程卡在那儿，所以这里
        # **退化为不屏蔽**：回退到原始列表，按 order_by="Expected" 点原来
        # 优先级最高的那个（= 剃光之前剩的那个）。
        # 理论上只有「原始列表只剩 1 项且它正好被屏蔽」会走到这里；
        # cat1/cat2/cat3 三支永远不会（能进那一支就说明武将在对应追踪名单里，
        # 链上先命中，banned 必为空集）。真正会剃光的只有 fallback 路径。
        _log(
            "Shield",
            f"警告：屏蔽 {sorted(banned)} 后待选为空，退化为不屏蔽：{expected}",
        )
        return expected

    _log("Shield", f"屏蔽生效：「{who}」命中，剔除 {sorted(banned)}：{expected} -> {kept}")
    return kept


# ==========================================================================
# 5.8 赠礼对照记录（名 -> 字）
# ==========================================================================


class GiftLog:
    """把「选择列表里点到谁」和「详情页标题是什么」记成对照表。

    选择列表写的是武将的**名**（陆逊赠礼），详情页标题写的是他的**字**
    （伯言赠礼）。同一场赠礼在两屏上完全是两个字符串，所以两个都要抄下来。

    文件一行一条，两栏用「:」连接、整条以「;」收尾：

        陆逊赠礼:伯言赠礼;
        范增赠礼:亚父赠礼;

    写入是幂等的：同一个组合只会落盘一次，所以反复跑脚本也不会把文件堆爆。
    首次写入前会先把已有内容读进内存建索引，因此重启 agent 后依然去重。
    """

    JOINER = ":"
    TERMINATOR = ";"

    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._seen: set[str] = set()
        self._loaded = False

    @property
    def path(self) -> str:
        return self._path

    def _load_locked(self) -> None:
        """把文件里已有的行读进 _seen（调用方必须已持锁）。"""
        if self._loaded:
            return
        self._loaded = True
        try:
            if os.path.isfile(self._path):
                with open(self._path, "r", encoding="utf-8") as fp:
                    for line in fp:
                        text = line.strip()
                        if text:
                            self._seen.add(text)
        except OSError as exc:
            _log("GiftLog", f"读取 {self._path} 失败（本次按空文件处理）: {exc}")

    def record(self, picked: str, title: str) -> None:
        """记一条对照。picked = 列表里点的名字，title = 详情页标题。

        任一项为空都不写：标题读不到通常只是 OCR 抖了一下，
        宁可不记，也不要往文件里塞半条脏数据。
        """
        picked = (picked or "").strip()
        title = (title or "").strip()

        if not picked:
            return
        if not title:
            _log("GiftLog", f"没读到「{picked}」对应的详情页标题，本次跳过记录")
            return

        line = f"{picked}{self.JOINER}{title}{self.TERMINATOR}"

        with self._lock:
            self._load_locked()
            if line in self._seen:
                return
            try:
                with open(self._path, "a", encoding="utf-8") as fp:
                    fp.write(line + "\n")
            except OSError as exc:
                _log("GiftLog", f"写入 {self._path} 失败: {exc}")
                return
            self._seen.add(line)

        _log("GiftLog", f"已记录赠礼对照: {line}")


GIFT_LOG = GiftLog(GIFT_LOG_PATH)


# ==========================================================================
# 5.9 记录模式：用「待记录名单」顶替 cat1
# ==========================================================================


# 名单里可能出现的各种分隔符：英文/中文逗号、顿号、分号、换行
_ROSTER_SPLIT_RE = re.compile(r"[,，、;；\r\n]+")

# 名字两端要剥掉的噪声字符：间隔号（徐盛·）、句号、空白等
_ROSTER_STRIP = "·．.。 \t\u3000"


def _parse_roster_text(text: str) -> list[str]:
    """把「所有武将」名单文本解析成 ["陈胜赠礼", "扶苏赠礼", ...]。

    源文件的形态改过好几版（裸名字 / 行尾带逗号 / 整行逗号分隔），所以这里
    统一按分隔符切，再剥掉两端的标点，最后补「赠礼」后缀 —— 三种形态都能吃。

    补后缀是幂等的：已带「赠礼」的名字不会变成「陈胜赠礼赠礼」，所以源文件里
    混着写「陈胜」和「陈胜赠礼」也不会出问题。
    """
    items: list[str] = []
    for chunk in _ROSTER_SPLIT_RE.split(text):
        name = chunk.strip().strip(_ROSTER_STRIP)
        if not name:
            continue
        if not name.endswith("赠礼"):
            name = f"{name}赠礼"
        if name not in items:
            items.append(name)
    return items


def _load_roster(path: str | None = None) -> list[str]:
    """读「所有武将」总名单。path 为空时按 GIFT_ROSTER_CANDIDATES 顺序探测。

    三个候选文件都读不到就返回空列表 —— 调用方据此退化为「不替换 cat1」，
    绝不会因为缺文件把赠礼主流程搞崩。
    """
    candidates = [path] if path else [
        os.path.join(_AGENT_DIR, name) for name in GIFT_ROSTER_CANDIDATES
    ]

    for item in candidates:
        if not item or not os.path.isfile(item):
            continue
        try:
            with open(item, "r", encoding="utf-8-sig") as fp:
                text = fp.read()
        except OSError as exc:
            _log("GiftRoster", f"读取名单 {item} 失败: {exc}")
            continue
        names = _parse_roster_text(text)
        if names:
            _log("GiftRoster", f"武将总名单: {os.path.basename(item)}（{len(names)} 人）")
            return names

    _log(
        "GiftRoster",
        "没找到任何可用的武将名单文件，已尝试: "
        + ", ".join(os.path.basename(c) for c in candidates),
    )
    return []


def _load_recorded_names() -> set[str]:
    """读 赠礼记录.txt，返回**两侧都算**的已记录名字（已归一化、去掉「赠礼」）。

    一行 `陆逊赠礼:伯言赠礼;` 里的两栏都要收：左栏是列表里点到的名字，
    右栏是详情页标题。判重时哪一侧对上都算这条武将已经记录过，
    所以左右两栏是「名」和「字」时都能正确挡住重复采集。
    """
    recorded: set[str] = set()
    if not os.path.isfile(GIFT_LOG_PATH):
        return recorded

    try:
        with open(GIFT_LOG_PATH, "r", encoding="utf-8-sig") as fp:
            lines = fp.readlines()
    except OSError as exc:
        _log("GiftRoster", f"读取 {GIFT_LOG_PATH} 失败（按无记录处理）: {exc}")
        return recorded

    terminator = GiftLog.TERMINATOR
    for line in lines:
        text = line.strip()
        if not text:
            continue
        if terminator and text.endswith(terminator):
            text = text[: -len(terminator)]
        for side in text.split(GiftLog.JOINER):
            name = _normalize_name(side)
            if name:
                recorded.add(name)
    return recorded


def _write_todo(path: str, items: Sequence[str]) -> None:
    """把待记录名单落盘（内容没变就不重写，避免每开一次面板都刷盘）。"""
    text = "".join(f"{name}\n" for name in items)
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8-sig") as fp:
                if fp.read() == text:
                    return
        with open(path, "w", encoding="utf-8") as fp:
            fp.write(text)
    except OSError as exc:
        _log("GiftRoster", f"写入 {path} 失败: {exc}")


def _build_record_todo() -> list[str]:
    """算出「总名单里有、但赠礼记录里还没出现过」的武将（保序）。

    这就是记录模式要拿来顶替 cat1 的那份列表 —— 每选中一个武将，GiftLog 就会
    把「名:字」写进记录文件，下次再算时它自然从这个列表里消失，
    于是同一局里不会反复去点同一个已经记录过的武将。
    """
    roster = _load_roster()
    if not roster:
        return []

    recorded = _load_recorded_names()
    todo = [name for name in roster if _normalize_name(name) not in recorded]

    _log(
        "GiftRoster",
        f"总名单 {len(roster)} 人 / 已记录 {len(recorded)} 个名字"
        f" -> 待记录 {len(todo)} 人",
    )
    return todo


def _with_record_mode(params: dict[str, Any]) -> dict[str, Any]:
    """记录模式开启时，用待记录名单顶替 UI 里的 cat1_list。

    由调用方按 RECORD_MODE 决定是否调用本函数（见 handle_gift_selection）。

    - 名单读不到 / 已经全部记录完 -> 原样返回，保留用户的 cat1_list
      （绝不能把 cat1 清空：清了就永远进不了 cat1 分支）
    - 算出待记录列表后顺便落盘一份到 待记录赠礼.txt，方便人工核对进度

    关于「顶替」：开启时 cat1_list 被**完全覆盖**，UI「赠礼配置」里填的
    信物武将本次不参与 —— 这是用户明确要的语义（冲突时以改后的列表为准）。
    """
    # 哨兵自检：params 来自「赠礼配置」，正常必然带全这几个键。
    # 一旦缺，说明 interface.json 里那份 override 被改坏了（或换了写法导致被
    # 整体替换掉），此时名单会静默变空 —— 那种退化很难察觉，所以显式报出来。
    lost = [k for k in ("cat1_list", "cat2_list", "fallback_priority") if k not in params]
    if lost:
        _log(
            "GiftRoster",
            f"警告：记录模式已开启，但参数里缺少 {lost} —— 请检查 interface.json 里"
            "「赠礼配置」的 pipeline_override 是否完整",
        )

    todo = _build_record_todo()
    if not todo:
        _log(
            "GiftRoster",
            "记录模式：没有待记录的武将（名单缺失或已全部记录完），本次沿用原 cat1_list",
        )
        return params

    _write_todo(GIFT_TODO_PATH, todo)

    merged = dict(params)
    merged["cat1_list"] = ",".join(todo)
    _log(
        "GiftRoster",
        f"记录模式：cat1_list 已替换为待记录名单（{len(todo)} 人），"
        f"列表见 {os.path.basename(GIFT_TODO_PATH)}",
    )
    return merged


# ==========================================================================
# 6. 名单与优先级策略
# ==========================================================================


def _build_full_list(category: str, list_str: str) -> list[str]:
    """把 UI 传入的 "吕布,马超" 解析成 ["吕布赠礼", "马超赠礼"]。

    - 兼容中英文逗号
    - 已带「赠礼」后缀的名字不会重复追加（旧版会变成「吕布赠礼赠礼」）
    - 名单为空时回落到该 category 的默认值（cat3 默认为空 = 默认不启用资助）
    """
    default = CAT_DEFAULT.get(category, [])

    items: list[str] = []
    for name in _split_names(list_str):
        if not name.endswith("赠礼"):
            name = f"{name}赠礼"
        if name not in items:
            items.append(name)
    return items or list(default)


def _active_list(category: str, list_str: str) -> list[str]:
    """当前可用于 OCR 的武将名单：排除已领取 + 应用 cat2 互斥规则。"""
    full = _build_full_list(category, list_str)
    active = STATE.pending(full, category)

    if category == "cat2" and CAT2_MUTEX:
        claimed = STATE.snapshot("cat2")
        active = [
            name
            for name in active
            if not (name in CAT2_MUTEX and CAT2_MUTEX[name] not in claimed)
        ]
    return active


def _reward_plan(priority: Sequence[str], branch: str) -> list[str]:
    """根据分支推导出奖励面板的 expected 列表（顺序即优先级）。

    branch:
        "cat1"     cat1 武将已选中但没拿到信物
        "cat2"     cat2 武将已选中但没拿到驰援
        "cat3"     cat3 武将已选中但没拿到资助
        "fallback" cat1、cat2、cat3 都没选中武将
    """
    priority = list(priority)

    if branch == "cat1":
        # 旧版：["并肩作战","武将牌","驰援","资助"]
        return _dedupe(priority)

    if branch == "cat2":
        # 旧版：["并肩作战","武将牌","资助","信物"]
        # 已经在「没驰援」的场景里，所以剔除驰援，再把信物垫底
        rest = [name for name in priority if name != CAT2_REWARD]
        return _dedupe(rest + [CAT1_REWARD])

    if branch == "cat3":
        # 同上：已经在「没资助」的场景里，剔除资助，再把信物垫底
        rest = [name for name in priority if name != CAT3_REWARD]
        return _dedupe(rest + [CAT1_REWARD])

    # 旧版：["并肩作战","武将牌","驰援","资助","信物"]
    return _dedupe(priority + [CAT1_REWARD])


# ==========================================================================
# 7. 赠礼流程：自定义识别与动作（v3 节点链）
# ==========================================================================


def _match_category(raw: str) -> str | None:
    """把图一 OCR 到的武将按钮文本对回分支（cat1 > cat2 > cat3）。

    按总优先级链顺序，第一个「名单核心名是 OCR 文本子串」的分支获胜
    （= 旧版 pick_cat1 -> pick_cat2 -> pick_cat3 依次尝试谁先命中谁生效）。
    对不上（OCR 噪声 / 不在名单里）返回 None —— 不点，交给框架下一轮。
    """
    norm = _normalize_name(raw)
    if not norm:
        return None
    for cat in ("cat1", "cat2", "cat3"):
        for name in _active_list(cat, CONFIG.lists.get(cat, "")):
            core = _normalize_name(name)
            if core and core in norm:
                return cat
    return None


@AgentServer.custom_recognition("pick_general")
class PickGeneral(CustomRecognition):
    """「点击目标武将」的自定义识别：识别图一底部那排武将按钮，对回 cat1/2/3。

    对应旧版 select_general 的「OCR 名单 -> 返回点击框」；点击由节点的
    Click 动作执行，点击是否生效由 next 自循环验证（见节点注释）：
      next[0] = 赠礼详情页 —— 目的地优先（v3.4）：详情页标题一能识别到
                 就直接进图二，过渡帧里旧按钮残留在背景上也绝不补第二下；
      next[1] = 自身   —— 标题不在 + 那排还在 = 还在图一（点击无效/没跳转），
                 重跑重点。
    转圈期间 OCR 读不到名单 -> 返回未命中 -> 框架下一轮重试（每轮重新截图），
    结构上不存在「在转圈画面上空点」。

    名单按 cat1 > cat2 > cat3 依次构建（_active_list：排除已领取 + cat2 互斥），
    合并成一份 expected（顺序即优先级，order_by="Expected"）；
    REQUIRED_CAT2 集齐后返回未命中 —— = 旧版 run() 的守卫：直接走赠礼按钮兜底。
    """

    def analyze(self, context: Context, argv: CustomRecognition.AnalyzeArg):
        try:
            merged: list[str] = []
            if not STATE.has_all(REQUIRED_CAT2):
                for cat in ("cat1", "cat2", "cat3"):
                    for name in _active_list(cat, CONFIG.lists.get(cat, "")):
                        if name not in merged:
                            merged.append(name)
            if not merged:
                return None

            result = _ocr(
                context, _screencap(context), "_gen", ROI_GENERAL_LIST, merged
            )
            if not result:
                return None

            cat = _match_category(result.text)
            if not cat:
                _log("PickGeneral", f"OCR 文本「{result.text}」未对回任何名单，不点")
                return None

            FLOW.stage(cat, result.text)
            _log("PickGeneral", f"选中 {cat}:{result.text} box={list(result.box)}")
            return self.AnalyzeResult(
                box=list(result.box), detail={"category": cat, "name": result.text}
            )
        except Exception as exc:  # 识别端绝不能抛异常拖垮 agent
            _log("PickGeneral", f"异常（按未命中处理）: {exc!r}")
            return None


@AgentServer.custom_action("gift_entered")
class GiftEntered(CustomAction):
    """「赠礼详情页」节点动作：标题 OCR 已命中 = 确认真的跳进了图二。

    对应旧版 select_general 选中武将后的两件事：
    1) cat1 武将在此领取（旧版 mark_claimed=True：进了详情页就算选中，
       后面奖励哪怕走兜底也不影响 cat1 记账）；
    2) 把「图一名字」和「详情页标题（= 该武将的字）」写进对照表（GiftLog）。

    兜底路径（由赠礼按钮兜底进来，没有 stage 过武将）只打日志，不领取、
    不记录 —— 与旧版 pick_fallback 一致。
    """

    def run(self, context: Context, argv: CustomAction.RunArg) -> bool:
        snap = FLOW.snapshot()
        if snap["category"] == "cat1" and snap["name"]:
            STATE.claim("cat1", snap["name"])
        title = _read_gift_title(context)
        if snap["name"]:
            GIFT_LOG.record(snap["name"], title)
        _log(
            "GiftEntered",
            f"已进入详情页：cat={snap['category']} name={snap['name']!r} 标题={title!r}",
        )
        return True


@AgentServer.custom_recognition("pick_reward")
class PickReward(CustomRecognition):
    """「选择目标奖励」的自定义识别：图二奖励面板上按优先级选出该点的奖励。

    对应旧版 _click_until_gone 的「OCR -> 返回点击框」部分，黑名单判定
    （_effective_expected：图二标题对 cat4/5/6）原样复用。点击由节点的
    Click 动作执行，next 自循环负责验证：
      next[0] = 自身 —— 点过的词还在 = 点击被吞，重点；
                        点过的词消失 = 领取生效（= 旧版「点到消失」），记账收尾；
      next[1] = 属性变化 —— 领取后弹出的属性弹窗（网络慢时约 1 秒才出现，
                        节点 post_delay=1000 给它留出加载时间）
      next[2] = 继续战斗 —— 奖励词没了 = 面板已关/已领取，收尾。

    v3.2 取消「标题必须含赠礼」的硬门禁（2026-10-02 10:59:40 日志复盘）：
    子义赠礼页打开后标题位被「武将技能」子页签顶掉，62 轮标题探针全部
    误判「不在图二」，pick_reward 一次都没跑到奖励 OCR，白卡 60 秒后进
    失败处理、最终被外层错误处理退出房间。面板上的奖励词本身就是
    「在图二」的证据 —— 这也是最初代码（无门禁）的行为；面板关了奖励词
    自然 OCR 不到，同样返回未命中交给 next 收尾，两不耽误。

    expected = 分支主奖励（cat1 信物 / cat2 驰援 / cat3 资助 / 兜底无）
    + 兜底优先级（_reward_plan），顺序即优先级；屏蔽名单命中时对应奖励被剃掉。
    """

    def analyze(self, context: Context, argv: CustomRecognition.AnalyzeArg):
        try:
            snap = FLOW.snapshot()
            if snap["done"]:
                return None

            image = _screencap(context)
            if image is None or getattr(image, "size", 0) == 0:
                return None

            # 「点到消失」判定（= 旧版 _click_until_gone 返回 got 的语义）：
            # 点过的词从面板上消失 = 上一击领取生效。cat2/cat3 只有点中
            # 主奖励才记账（= 旧版 if got: STATE.claim）；随后收尾，
            # 交给 next 的 属性变化/继续战斗（面板关闭后命中）。
            if snap["clicked_word"]:
                still = _ocr(
                    context, image, "_pr_gone", ROI_REWARD_PANEL, [snap["clicked_word"]]
                )
                if not still:
                    cat = snap["category"]
                    if cat in ("cat2", "cat3"):
                        primary = CAT2_REWARD if cat == "cat2" else CAT3_REWARD
                        if primary in snap["clicked_word"]:
                            STATE.claim(cat, snap["name"])
                            _log("PickReward", f"{cat} 点中主奖励，已记账: {snap['name']}")
                    FLOW.finish()
                    return None
                # 词还在 = 点击被吞 -> 继续往下走，返回同一个框重点

            cat = snap["category"]
            if cat == "cat1":
                expected = [CAT1_REWARD] + _reward_plan(CONFIG.priority, "cat1")
            elif cat == "cat2":
                expected = [CAT2_REWARD] + _reward_plan(CONFIG.priority, "cat2")
            elif cat == "cat3":
                expected = [CAT3_REWARD] + _reward_plan(CONFIG.priority, "cat3")
            else:
                # 兜底路径（赠礼按钮兜底进来，没有 stage 过武将）
                expected = _reward_plan(CONFIG.priority, "fallback")
            expected = _effective_expected(context, _dedupe(expected))

            result = _ocr(context, image, "_cug", ROI_REWARD_PANEL, expected)
            if not result:
                return None

            FLOW.note_click(result.text)
            _log("PickReward", f"cat={cat} 点「{result.text}」box={list(result.box)}")
            return self.AnalyzeResult(
                box=list(result.box), detail={"text": result.text, "category": cat}
            )
        except Exception as exc:
            _log("PickReward", f"异常（按未命中处理）: {exc!r}")
            return None


# ==========================================================================
# 8. 自定义动作
# ==========================================================================


@AgentServer.custom_action("set_gift_record_mode")
class SetGiftRecordMode(CustomAction):
    """把 UI「是否自动采集赠礼对照」开关的状态带进 agent。

    挂在 pipeline 的「选择赠礼」节点上，每次进赠礼面板都会先执行一次，
    所以 RECORD_MODE 永远是最新值，不需要在任何地方复位。

    为什么不让「动态选择赠礼」的 custom_action_param 直接带上这个开关？
    因为那个节点的 action 已被「赠礼配置」override 覆盖，而 override 是
    **整体替换 action** 的（实机日志已证实）：再加一个 option 去改同一个 action，
    就必须把 type / custom_action / 全部 param 抄全；可 param 里那 7 个值都是
    「赠礼配置」的 input 占位符，而占位符替换是按各 option **自己的 inputs** 做的 ——
    抄过来会原样剩下字面量 "{cat1_list}"，比不生效更糟（名单全废）。
    挂到另一个节点上就完全没有这些约束：param 里只有一个字面量 mode。

    这个动作永远返回 True：它只是读个开关，绝不该影响赠礼主流程。
    """

    def run(self, context: Context, argv: CustomAction.RunArg) -> bool:
        global RECORD_MODE
        params = _parse_params(getattr(argv, "custom_action_param", None))
        RECORD_MODE = _as_bool(params.get("mode"))
        _log("GiftRoster", f"记录模式{'开启' if RECORD_MODE else '关闭'}")
        return True


@AgentServer.custom_action("handle_gift_selection")
class HandleGiftSelection(CustomAction):
    """「动态选择赠礼」节点动作：只做装配，不碰屏幕（v3）。

    - 记录模式开启时用「待记录名单」顶替 UI 里的 cat1_list；
    - 6 份名单 + 兜底优先级统一进 CONFIG（屏蔽判定等底层从这里取）；
    - 复位 FLOW（上一次赠礼事件的分支 / 点击词清零）。

    真正的选将 / 选奖励由后续节点链完成：
        点击目标武将(pick_general) -> 赠礼详情页(gift_entered)
        -> 选择目标奖励(pick_reward) -> 继续战斗
    每一步的 next 第一项都是它本身：先验证本步是否生效，再走下一步。
    """

    def run(self, context: Context, argv: CustomAction.RunArg) -> bool:
        params = _parse_params(getattr(argv, "custom_action_param", None))
        # 服务端下发的动作配置项覆盖 interface.json 打包默认（配置变量/修改变量通道），
        # 网页改名单/层数上限下个心跳生效；monitor 客户端不可用时零影响
        try:
            import monitor_client

            params = monitor_client.override_params(params)
            monitor_client.note(任务="赠礼选择")
            # 挂机时段外（run_range 判定 false：未配置/格式无效/不在时段内）
            # -> 暂停全部动作，只执行心跳，停止本轮任务
            if monitor_client.actions_paused():
                _log("GiftFlow", "挂机时段内判定为 false -> 暂停全部动作, 只执行心跳")
                monitor_client.note(动作状态="时段外暂停")
                context.tasker.post_stop()
                return True
        except Exception:
            pass
        # 记录模式：算出「还没记录过的武将」，顶替 UI 里的 cat1_list
        if RECORD_MODE:
            params = _with_record_mode(params)
        # 6 份名单 + 兜底优先级统一进 CONFIG，底层的屏蔽判定直接从里面取
        CONFIG.load(params)
        FLOW.reset()
        for cat in CAT_CHAIN:
            kind = (
                f"屏蔽{','.join(CAT_BAN_REWARDS[cat])}"
                if cat in CAT_BAN_REWARDS
                else "追踪"
            )
            _log("GiftFlow", f"{cat}_list（{kind}）: {CONFIG.lists[cat] or '（空）'}")
        _log("GiftFlow", f"兜底奖励优先级: {CONFIG.priority}")
        for cat in ("cat1", "cat2", "cat3"):
            _log("GiftFlow", f"已领取 {cat}: {STATE.snapshot(cat)}")
        return True


@AgentServer.custom_action("reset_gift_state")
class ResetGiftState(CustomAction):
    """重置赠礼状态 —— 每次千里开局选将后执行一次。"""

    def run(self, context: Context, argv: CustomAction.RunArg) -> bool:
        STATE.reset()
        _log("Reset", "重置赠礼状态，清空已领取武将")
        return True


@AgentServer.custom_action("CheckNumberAndStop")
class CheckNumberAndStop(CustomAction):
    """层数超过阈值时停止整个任务（限制冲榜）。"""

    def run(self, context: Context, argv: CustomAction.RunArg) -> bool:
        image = context.tasker.controller.cached_image
        reco = context.run_recognition_direct(
            JRecognitionType.OCR,
            JOCR(roi=ROI_FLOOR, expected=[]),
            image,
        )
        if not (reco and reco.hit):
            return True

        text = reco.best_result.text
        _log("CheckNumber", f"当前层数为{text}")
        try:
            number = int(text)
        except (TypeError, ValueError):
            _log("CheckNumber", "这层有bug，请换一层")
            return True

        # monitor 挂钩：上报层数 + 远程 stop 指令 + 挂机时段 + 服务端下发的层数上限
        floor_limit = STOP_FLOOR
        try:
            import monitor_client

            monitor_client.note(层数=number)
            if monitor_client.should_stop():
                _log("CheckNumber", "maa_cmd=stop -> 远程停止任务")
                context.tasker.post_stop()
                return True
            # 挂机时段内判定为 false -> 暂停全部动作，只执行心跳
            if monitor_client.actions_paused():
                _log("CheckNumber", "挂机时段内判定为 false -> 暂停全部动作, 只执行心跳")
                context.tasker.post_stop()
                return True
            floor_limit = monitor_client.floor_limit(STOP_FLOOR)
        except Exception:
            pass

        if number > floor_limit:
            _log("CheckNumber", f"{number} 超过限制{floor_limit}，不允许冲榜")
            context.tasker.post_stop()
        return True


@AgentServer.custom_action("ClearHitCountAction")
class ClearHitCountAction(CustomAction):
    """清除「节点中检测限制冲榜」的命中计数。"""

    def run(self, context: Context, argv: CustomAction.RunArg) -> bool:
        context.clear_hit_count("节点中检测限制冲榜")
        return True


# ==========================================================================
# 8.7 安卓端自动启动游戏
# ==========================================================================

# 名将杀（巨人网络）安卓版包名（官方渠道确认：com.ztgame.mjs）
GAME_ANDROID_PACKAGE = "com.ztgame.mjs"

# 启动游戏后等待画面出现的最长时间（秒）。冷启动（首次要解压 3GB+ 资源）可能很慢，
# 超时后仍放行任务 —— 交给各任务入口节点链自身的 next 轮询/超时兜底，日志会留痕。
GAME_LAUNCH_TIMEOUT = 120.0
GAME_LAUNCH_POLL_INTERVAL = 1.0
# 画面判定阈值：截图标准差低于该值视为纯黑/纯色（虚拟屏上还没有游戏画面）
GAME_FRAME_STD_THRESHOLD = 3.0


def _is_adb_controller() -> bool:
    """按 PI 环境变量判断当前控制器是否为安卓 Adb。

    PI v2.5 约定：Client 启动 agent 子进程时注入 PI_CONTROLLER —— 单行 JSON，
    即 interface.json controller 数组中用户当前选中的那一条（含 type 字段）。
    本项目两条 controller：安卓端（type=Adb）、桌面端（type=Win32）。

    判定采取保守方向：env 缺失 / 解析失败 / type 不是 adb -> 一律按 Windows
    处理并跳过启动，保证桌面端行为与从前完全一致（宁可不启动，绝不误启）。
    """
    raw = os.environ.get("PI_CONTROLLER", "")
    if not raw:
        return False
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return False
    return isinstance(data, dict) and str(data.get("type", "")).lower() == "adb"


def _wait_game_screen(context: Context) -> bool:
    """轮询截图，等屏幕（后台模式下即虚拟屏）上出现非纯黑画面。"""
    deadline = time.time() + GAME_LAUNCH_TIMEOUT
    while time.time() < deadline:
        image = _screencap(context)
        if image is not None and getattr(image, "size", 0) > 0:
            try:
                if float(image.std()) > GAME_FRAME_STD_THRESHOLD:
                    return True
            except Exception:
                # std 计算不可用（图像格式异常等）时不再纠缠，
                # 交给任务流程自身的识别超时兜底
                return True
        time.sleep(GAME_LAUNCH_POLL_INTERVAL)
    return False


@AgentServer.custom_action("launch_game")
class LaunchGame(CustomAction):
    """安卓端启动游戏并等它渲染出画面；Windows 端直接跳过（零影响）。

    背景（2026-10-12 排查结论）：MaaFwApp 后台模式只负责建虚拟屏，**不会**
    自己拉起游戏 —— 壳的 RunEnvHook 明说「start_app 的包名来自 pipeline，
    外壳不维护包名表」；而本项目 pipeline 从未有过启动游戏节点，所以安卓端
    虚拟屏上始终黑屏（帧缓冲为空、可点击但无画面），任务 OCR 全 Failed。

    本动作挂在各任务入口的「启动游戏」节点上：
    - Adb 控制器：post_start_app(包名) -> 轮询截图等画面出现再放行任务；
    - Win32 控制器：直接返回 True，行为与从前完全一致。
    """

    def run(self, context: Context, argv: CustomAction.RunArg) -> bool:
        if not _is_adb_controller():
            _log("LaunchGame", "非安卓 Adb 控制器，跳过启动游戏")
            return True
        try:
            _log("LaunchGame", f"安卓端启动游戏: {GAME_ANDROID_PACKAGE}")
            context.tasker.controller.post_start_app(GAME_ANDROID_PACKAGE).wait()
        except Exception as exc:  # noqa: BLE001 - 启动失败也继续等画面，由日志留痕
            _log("LaunchGame", f"post_start_app 异常（继续等待画面）: {exc!r}")
        ok = _wait_game_screen(context)
        _log(
            "LaunchGame",
            "游戏画面已出现，任务放行" if ok else "等待画面超时，交由任务流程继续",
        )
        return True


# ==========================================================================
# 8.5 守城将自定义屏蔽武将（公会战）
#
# 刷新逻辑（2026-10-08 改版）：
#   旧版：当前城池守城将命中屏蔽名单 -> 立刻触发「公会战城池刷新」。
#   新版：命中后**先不刷新**，而是在左侧城池列表里逐个点击其它城池、
#         重新检测守城将：
#     - 跳过带「已成功掠夺」绶带的城池（已经打过，无法再次攻打）；
#     - 一旦找到无屏蔽武将的城池 -> 识别不命中（该城池已被选中），
#       交回原 next 链走正常出征流程；
#     - 当**所有可攻打的城池**都命中屏蔽武将（或全部已掠夺、无可攻打
#       城池）时，识别才命中 -> next 里的「公会战城池刷新」执行换一批。
#   整个换城检测在识别端一次 analyze 内完成（内部点击城池行），
#   管线结构不变，只是「命中」的含义从"当前城池命中"变成
#   "所有剩余城池均命中"。
# ==========================================================================

# 守城将三张武将牌竖排名的 ROI（1280x720 坐标系，与 识别武将名.json 保持一致）
DEFENSE_GENERAL_ROIS: dict[str, tuple[int, int, int, int]] = {
    "左": (622, 268, 40, 92),
    "中": (772, 268, 40, 92),
    "右": (921, 268, 40, 92),
}

# 三张武将牌整块面板（一次 OCR 覆盖三个位置，按 x 归位槽位）。
# 2026-10-08 19:45 事故：单回调内几十次 run_recognition_direct 重入 IPC
# 触发 AgentServer 竞态（挂死 + 空响应），改为合并调用把每城 OCR 从 3 次降到 1 次。
TRIO_PANEL_ROI = (600, 260, 420, 112)
TRIO_SLOT_X_BOUNDARIES = (720, 870)    # 中心 x < 720 -> 左；720~870 -> 中；> 870 -> 右

# ---- 选择城池弹窗 · 敌方城池列表几何参数（1280x720 基准，实测自 2026-10-08 截图）----
# 城池行自上而下共 5 行：第 1 行条目框 y 204~261，行距 64。
CITY_ROW_COUNT = 5
CITY_ROW_TOP_Y = 204        # 第 1 行条目框上边缘
CITY_ROW_HEIGHT = 57        # 条目框高度
CITY_ROW_PITCH = 64         # 相邻两行的行距
CITY_CLICK_X = 490          # 行内点击 x（行中部，避开左侧国家徽章与右缘）
# 名字行基线：第 1 行城池名中心 y=219，之后每行 +64；OCR 竖带覆盖全部 5 行
CITY_NAME_BAND_ROI = (420, 205, 140, 290)
CITY_NAME_BASE_Y = 219
# 已成功掠夺绶带基线：第 1 行绶带中心 y=248，之后每行 +64
CITY_PLUNDER_BAND_ROI = (445, 232, 120, 284)
CITY_PLUNDER_BASE_Y = 248
PLUNDER_KEYWORD = "掠夺"    # 「已成功掠夺」的子串（expected 为正则 search 语义）
# 「设为目标」按钮（实测 bbox 1280: 634,538,185,42，中心 726,559）。
# 换城点击列表行只是"选中"看守城将，找到干净城池后必须点它确认目标，
# 之后管线 next 链上的「关闭单刷筛选城池」才有关闭意义。
SET_TARGET_CLICK = (726, 559)
SET_TARGET_SETTLE_DELAY = 0.9   # 设为目标后的界面稳定等待
# ---- 列表翻页（2026-10-08：城池共 8 个，每页只显示 5 个）----
# 顶部一页查完没有干净城池时，手指上滑翻到底部一页（露出第 4~8 个城池），
# 两页并集覆盖全部 8 个；翻完仍无干净城池才触发城池刷新。
CITY_PAGE_COUNT = 2
# 上滑手势（1280x720 基准）：begin 在下、end 在上 = 手指上移、内容上移，
# 列表露出更下面的城池；快滑带惯性，翻到底会被列表自然钳住。
CITY_SCROLL_TO_BOTTOM = ((470, 470), (470, 210))
CITY_SCROLL_DURATION = 250      # 快滑（有惯性，滑到底会被列表钳住）
CITY_SCROLL_SETTLE_DELAY = 1.0  # 滑动后等列表停稳
# 聚类残差容差：OCR 框中心 y 距离行基线超过该值视为另一条线（费用行等）的文本
CITY_ROW_CLUSTER_TOL = 16

# 识别超时参数：守城将名字没刷出来时的重试
# （2026-10-08 压缩：单次识别回调越短越稳——maafw AgentServer 在超长回调期间
#   有 abort 崩溃记录，见 debug 转储 ucrtbase abort <- MaaAgentServer.dll）
TRIO_READ_RETRY = 2
TRIO_READ_INTERVAL = 0.35
# 换城点击后的面板加载等待
SWITCH_SETTLE_DELAY = 0.6
# 单次自定义识别回调的时间预算（秒）：换城检测全部逻辑必须在此时间内完成，
# 超时立即放弃逐城检测、走城池刷新（刷新后下一轮会重新完整检测），兜底防崩溃。
CALLBACK_TIME_BUDGET = 20.0

# 屏蔽名单兜底：interface 占位符替换失败（收到 "{屏蔽守城将}" 字面量）或留空时使用。
# 优先读 agent/屏蔽守城将.txt（逗号/顿号/换行分隔），没有该文件则用下面的内置默认。
DEFAULT_BLOCK_GENERALS = ["祖逖", "周勃", "夏侯惇"]


def _load_block_generals() -> list[str]:
    """读本地屏蔽名单文件，读不到或为空则返回内置默认。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "屏蔽守城将.txt")
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            raw = f.read()
    except OSError:
        return list(DEFAULT_BLOCK_GENERALS)
    names = [
        n.strip()
        for n in raw.replace("，", ",").replace("、", ",").replace("\n", ",").split(",")
        if n.strip()
    ]
    return names or list(DEFAULT_BLOCK_GENERALS)


def _iter_ocr_results(reco: Any, strict: bool = False) -> list[tuple[str, list[int]]]:
    """从一次识别结果里捞出全部 OCR (text, box) 对（不只命中项）。

    与 _ocr_all_texts 同一套回退链（filtered_results -> all_results/detail ->
    best_result），但保留 box —— 城池列表扫描要靠 box 中心 y 把文本归位到行。

    strict=True 时只认 filtered_results（expected 过滤后的命中项），
    过滤后为空就返回空列表 —— 供「已成功掠夺」这类 expected 过滤扫描使用。
    千万不能对这类扫描开回退：过滤为空说明页面上没有绶带，一旦回退到
    全量文本（费用「4.6万」、城名「定郭」等），它们的中心 y 恰好逐行落在
    掠夺绶带基线上，会把每一行都误判成「已成功掠夺」直接触发刷新。
    （2026-10-08 实测刷新后新一批城池第 1 页无绶带时必现。）
    """
    results: list[tuple[str, list[int]]] = []

    def _push(item: Any) -> None:
        text = getattr(item, "text", "") or (item.get("text", "") if isinstance(item, dict) else "")
        box = getattr(item, "box", None) or (item.get("box") if isinstance(item, dict) else None)
        if text:
            results.append((text, list(box) if box else [0, 0, 0, 0]))

    for result in list(getattr(reco, "filtered_results", None) or []):
        _push(result)
    if results:
        return results
    if strict:
        return []
    for attr in ("all_results", "detail"):
        raw = getattr(reco, attr, None)
        if isinstance(raw, dict):
            for result in list(raw.get("all") or []):
                _push(result)
        elif raw:
            for result in list(raw):
                _push(result)
    if not results:
        best = getattr(reco, "best_result", None)
        if best is not None and getattr(best, "text", ""):
            _push(best)
    return results


def _read_defense_trio(context: Context, image) -> dict[str, tuple[str, list[int]]]:
    """一次 OCR 读守城将整块面板，按 x 归位三个槽位，返回 {slot: (text, box)}。

    用一次覆盖三个位置的 OCR 替代逐槽位 3 次调用：
    大幅减少回调内的重入 IPC 次数（AgentServer 竞态的高危因素）。
    """
    reco = context.run_recognition_direct(
        JRecognitionType.OCR,
        JOCR(roi=list(TRIO_PANEL_ROI), expected=[]),
        image,
    )
    items = _iter_ocr_results(reco) if reco else []
    if not items:
        return {}

    lo, hi = TRIO_SLOT_X_BOUNDARIES
    px, py, pw, ph = TRIO_PANEL_ROI
    by_slot: dict[str, list[tuple[str, list[int]]]] = {}
    for text, box in items:
        if not text.strip():
            continue
        center_x = box[0] + box[2] / 2
        center_y = box[1] + box[3] / 2
        # 防御性边界过滤：面板外的文本（坐标异常/其它区域噪声）不参与归位
        if not (px <= center_x <= px + pw) or not (py <= center_y <= py + ph):
            continue
        slot = "左" if center_x < lo else ("中" if center_x < hi else "右")
        by_slot.setdefault(slot, []).append((text, box))

    found: dict[str, tuple[str, list[int]]] = {}
    for slot, group in by_slot.items():
        # 竖排名可能被拆成多条结果：按 y 再 x 排序后拼接
        group.sort(key=lambda tb: (tb[1][1], tb[1][0]))
        text = "".join(t for t, _ in group)
        box = group[0][1]
        found[slot] = (text, list(box))
    return found


def _trio_blocked(
    found: dict[str, tuple[str, list[int]]], block_list: list[str]
) -> tuple[bool, str | None, str | None, str | None]:
    """判断守城将是否命中屏蔽名单。

    - 名单名与 OCR 文本双向包含即算命中（双方 ≥2 字时）；
    - 单字名单（如按姓氏屏蔽「祖」）：OCR 文本包含该字即命中；
    - OCR 文本本身过短（噪声 "K"、"2"）时仅精确匹配，防误触发。
    返回 (是否命中, 槽位, OCR文本, 命中的名单名)。
    """
    for slot, (text, _box) in found.items():
        for name in block_list:
            if len(text) < 2:
                # OCR 短噪声：只认精确相等
                if name == text:
                    return True, slot, text, name
                continue
            if len(name) >= 2:
                if name in text or text in name:
                    return True, slot, text, name
            else:
                # 单字名单：文本包含该字即命中（用户按姓氏屏蔽的场景）
                if name in text:
                    return True, slot, text, name
    return False, None, None, None


def _cluster_row_index(center_y: float, base_y: int) -> int | None:
    """把 OCR 框中心 y 归位到城池行号（0 起）；不属于目标行线时返回 None。"""
    row = round((center_y - base_y) / CITY_ROW_PITCH)
    if not 0 <= row < CITY_ROW_COUNT:
        return None
    if abs(center_y - (base_y + row * CITY_ROW_PITCH)) > CITY_ROW_CLUSTER_TOL:
        # 落在两行之间的线上（如费用行文本混进名字带）——不是这一行
        return None
    return row


def _scan_city_rows(context: Context, image) -> list[dict[str, Any]]:
    """扫描左侧城池列表的 5 行，返回 [{idx, name, plundered}]。

    - plundered：该行费用位置出现「已成功掠夺」绶带（已打过，无法再攻打）
    - name：仅用于日志，读不到不影响流程
    """
    rows: list[dict[str, Any]] = [
        {"idx": i, "name": "", "plundered": False} for i in range(CITY_ROW_COUNT)
    ]

    # 1) 已成功掠夺 绶带（expected 过滤，只返回含「掠夺」的文本）
    #    strict=True：过滤后为空就认定该页没有绶带，绝不回退到全量文本
    reco = context.run_recognition_direct(
        JRecognitionType.OCR,
        JOCR(roi=list(CITY_PLUNDER_BAND_ROI), expected=[PLUNDER_KEYWORD]),
        image,
    )
    for text, box in _iter_ocr_results(reco, strict=True) if reco else []:
        center_y = box[1] + box[3] / 2
        row = _cluster_row_index(center_y, CITY_PLUNDER_BASE_Y)
        if row is not None:
            rows[row]["plundered"] = True

    # 2) 城池名（expected 留空 = 任意文字，靠 y 聚类归位，仅日志用）
    reco = context.run_recognition_direct(
        JRecognitionType.OCR,
        JOCR(roi=list(CITY_NAME_BAND_ROI), expected=[]),
        image,
    )
    for text, box in _iter_ocr_results(reco) if reco else []:
        center_y = box[1] + box[3] / 2
        row = _cluster_row_index(center_y, CITY_NAME_BASE_Y)
        if row is not None:
            rows[row]["name"] += text

    _log(
        "DefenseGenerals",
        "城池列表: "
        + "; ".join(
            f"第{r['idx'] + 1}行「{r['name'] or '?'}」{'已掠夺' if r['plundered'] else '可检测'}"
            for r in rows
        ),
    )
    return rows


def _scroll_city_list(context: Context) -> None:
    """城池列表上滑翻页：露出当前页下面的城池（滑到底被列表钳住）。"""
    (x1, y1), (x2, y2) = CITY_SCROLL_TO_BOTTOM
    try:
        context.tasker.controller.post_swipe(x1, y1, x2, y2, CITY_SCROLL_DURATION).wait()
    except Exception as exc:    # noqa: BLE001 - 控制器接口异常不能中断整个检测
        _log("DefenseGenerals", f"城池列表上滑失败: {exc}")
        return
    time.sleep(CITY_SCROLL_SETTLE_DELAY)


def _read_trio_with_retry(
    context: Context, image, retries: int, interval: float, abort=None
) -> tuple[dict[str, tuple[str, list[int]]], Any]:
    """读守城将三位置名字，名字没刷出来时按间隔重试（等面板加载）。

    识别到武将名时输出到控制台（_log 同时写 agent日志.txt），方便人工核对
    OCR 到底读到了谁 —— 所有识别路径（当前城池 / 换城检测 / empty 模式）都走这里。
    abort: 看门狗超时事件，重试间隔处检查，孤儿线程尽快收手不再发桥接请求。
    """
    found: dict[str, tuple[str, list[int]]] = {}
    for attempt in range(retries):
        found = _read_defense_trio(context, image)
        if found:
            desc = "/".join(
                f"{slot}:{found[slot][0]}"
                for slot in ("左", "中", "右")
                if slot in found
            )
            _log("DefenseGenerals", f"识别到守城将: {desc}")
            return found, image
        if abort is not None and abort.is_set():
            return found, image
        time.sleep(interval)
        image = _screencap(context)
        if image is None or getattr(image, "size", 0) == 0:
            return {}, None
    return found, image


@AgentServer.custom_recognition("check_defense_generals")
class CheckDefenseGenerals(CustomRecognition):
    """识别守城将三个位置上的武将名，按 custom_recognition_param 分两种模式：

    - mode="blocked"：**多城池换位检测**（2026-10-08 改版）
        1. 检测当前选中城池：守城将命中屏蔽名单 -> 不急着刷新，先看别的城；
           未命中 -> 返回未命中（交回 next 链直接出征）；
           三个位置名字都没刷出来（重试后仍为空）-> 沿用旧语义返回未命中。
        2. 命中后逐个点击左侧列表其它城池行、重新检测守城将：
           - 「已成功掠夺」的城池直接跳过（已打过，无法再次攻打）；
           - 找到无屏蔽武将的城池 -> 点「设为目标」确认目标，返回未命中
             -> 管线关闭弹窗后按新城池正常出征；
           - 点击后名字没刷出来 -> 视为无法判定，换下一城；
           - 点击后仍是同一批已命中的守城将 -> 继续下一城。
        3. 列表共 8 个城池、每页只显示 5 个：第 1 页查完没有干净城池时
           上滑翻到底部一页（露出第 4~8 个）继续查，两页并集覆盖全部。
        4. 所有可攻打城池（两页）都命中屏蔽武将（或全部已掠夺）->
           返回命中，交由 next 的「公会战城池刷新」换一批；
           刷新后的下一轮会重新执行完整的两页挑选。
    - mode="empty"  ：三个位置都没识别到任何武将名 -> 命中
      （用于触发「关闭单刷筛选城池」；名字没刷出来也按没识别到处理）

    custom_recognition_param 示例:
        {"mode": "blocked", "block_list": "吕布,大乔"}
        {"mode": "empty"}
    """

    def analyze(self, context: Context, argv: CustomRecognition.AnalyzeArg):
        """看门狗包装：检测逻辑在子线程执行，超时强制返回「刷新」兜底。

        背景：2026-10-08 19:45 事故中 AgentServer 竞态导致回调内
        run_recognition_direct 挂死，框架侧无限等待，整个任务停摆。
        有了看门狗后框架最多等 CALLBACK_TIME_BUDGET 秒。
        """
        outcome: dict[str, Any] = {}
        abort = threading.Event()    # 超时后通知孤儿工作线程尽快停止发桥接请求

        def worker() -> None:
            try:
                outcome["value"] = self._analyze_impl(context, argv, abort)
            except Exception:    # noqa: BLE001 - 异常也要返回未命中而非挂死框架
                import traceback

                _log("DefenseGenerals", "回调内异常:\n" + traceback.format_exc(limit=8))
                outcome["value"] = None

        t = threading.Thread(target=worker, name="DefenseGeneralsWorker", daemon=True)
        t.start()
        t.join(CALLBACK_TIME_BUDGET)
        if t.is_alive():
            # 该工作线程已挂死，标记后由下一轮回调直接走兜底，避免堆积卡死线程
            abort.set()
            type(self)._hung_workers = getattr(type(self), "_hung_workers", 0) + 1
            _log(
                "DefenseGenerals",
                f"回调超过 {CALLBACK_TIME_BUDGET:.0f}s 未完成（agent IPC 竞态挂死）"
                " -> 兜底返回刷新；下一轮跳过检测直接刷新",
            )
            return self.AnalyzeResult(
                box=(1040, 540, 80, 40),
                detail={"mode": "blocked", "result": "watchdog_timeout"},
            )
        return outcome.get("value")

    def _analyze_impl(self, context: Context, argv: CustomRecognition.AnalyzeArg, abort=None):
        # abort: 看门狗超时置位的事件；孤儿线程在各步骤间检查，尽快退出，
        # 停止继续发桥接请求（避免响应错位 -> Bridge request timeout）。
        params = _parse_params(getattr(argv, "custom_recognition_param", None))
        mode = str(params.get("mode", "blocked")).strip().lower()
        block_list = [
            name.strip()
            for name in str(params.get("block_list", "")).replace("，", ",").split(",")
            if name.strip()
        ]

        # 上一轮的检测线程还挂着（IPC 竞态未恢复）：本轮不再发任何 RPC，
        # 直接走刷新兜底，等刷新后的新界面自然恢复；全程只打日志。
        if getattr(type(self), "_hung_workers", 0) > 0 and mode == "blocked":
            type(self)._hung_workers = 0    # 本轮已兜底，重置计数观察下一轮
            _log(
                "DefenseGenerals",
                "上一轮检测线程仍挂死 -> 本轮跳过检测，直接执行城池刷新兜底",
            )
            return self.AnalyzeResult(
                box=(1040, 540, 80, 40),
                detail={"mode": "blocked", "result": "prev_worker_hung"},
            )

        if not block_list or any("{" in n or "}" in n for n in block_list):
            # interface 占位符未被替换（收到 "{屏蔽守城将}" 字面量）或未配置 -> 本地名单兜底
            fallback = _load_block_generals()
            _log(
                "DefenseGenerals",
                f"block_list 未生效({params.get('block_list')!r})，使用本地名单: {fallback}",
            )
            block_list = fallback
        else:
            _log("DefenseGenerals", f"生效屏蔽名单: {block_list}")

        if abort is not None and abort.is_set():
            _log("DefenseGenerals", "看门狗已超时 -> 孤儿检测线程立即退出")
            return None

        image = _screencap(context)
        if image is None or getattr(image, "size", 0) == 0:
            _log("DefenseGenerals", "截图失败，本次跳过判定")
            return None

        # 逐个位置 OCR（expected 留空 = 匹配任意文字，靠 _ocr_all_texts 捞全量结果）
        found, _ = _read_trio_with_retry(context, image, TRIO_READ_RETRY, TRIO_READ_INTERVAL, abort)

        if mode == "empty":
            if found:
                return None
            _log("DefenseGenerals", "三个位置均未识别到武将名 -> 关闭单刷筛选城池")
            return self.AnalyzeResult(box=(620, 260, 400, 130), detail={"mode": "empty"})

        # ---- blocked 模式：多城池换位检测 ----
        if not found:
            _log(
                "DefenseGenerals",
                f"当前城池守城将名字未刷出来（重试 {TRIO_READ_RETRY} 次）-> 不命中，交回出征流程",
            )
            return None

        hit, slot, text, name = _trio_blocked(found, block_list)
        if not hit:
            _log("DefenseGenerals", "当前城池无屏蔽武将 -> 直接出征")
            return None

        current_desc = "/".join(f"{s}:{t}" for s, (t, _b) in found.items())
        _log(
            "DefenseGenerals",
            f"当前城池命中屏蔽武将（{slot}位 {text!r} 命中 {name!r}，守城将 {current_desc}）"
            " -> 开始检查其它城池",
        )

        # ---- 逐页检查城池列表：共 8 个城池、每页 5 个 ----
        # 第 1 页（当前可见 5 行）查完没有干净城池 -> 上滑翻到底部一页
        # （露出第 4~8 个）继续查；两页都查完仍无干净城池 -> 刷新。
        checked: list[str] = []
        t_start = time.monotonic()
        for page in range(CITY_PAGE_COUNT):
            if abort is not None and abort.is_set():
                _log("DefenseGenerals", "看门狗已超时 -> 孤儿检测线程立即退出（翻页前）")
                return None
            if time.monotonic() - t_start > CALLBACK_TIME_BUDGET:
                _log(
                    "DefenseGenerals",
                    f"换城检测耗时超预算({CALLBACK_TIME_BUDGET:.0f}s) -> 提前执行城池刷新兜底",
                )
                break
            if page > 0:
                _log("DefenseGenerals", "本页无可检测城池或均命中屏蔽 -> 上滑查看下一页城池")
                _scroll_city_list(context)

            page_image = _screencap(context)
            if page_image is None or getattr(page_image, "size", 0) == 0:
                _log("DefenseGenerals", f"第 {page + 1} 页截图失败，跳过该页")
                continue

            rows = _scan_city_rows(context, page_image)
            candidates = [r for r in rows if not r["plundered"]]
            if not candidates:
                _log("DefenseGenerals", f"第 {page + 1} 页无可攻打的城池（全部已掠夺）")
                continue

            for row in candidates:
                if abort is not None and abort.is_set():
                    _log("DefenseGenerals", "看门狗已超时 -> 孤儿检测线程立即退出（换城前）")
                    return None
                if time.monotonic() - t_start > CALLBACK_TIME_BUDGET:
                    _log(
                        "DefenseGenerals",
                        f"换城检测耗时超预算({CALLBACK_TIME_BUDGET:.0f}s) -> 提前执行城池刷新兜底",
                    )
                    break
                idx = row["idx"]
                label = row["name"] or f"第{idx + 1}行"
                click_y = CITY_ROW_TOP_Y + CITY_ROW_HEIGHT // 2 + idx * CITY_ROW_PITCH
                _log("DefenseGenerals", f"切换到城池「{label}」（第{idx + 1}行）检测守城将")
                context.tasker.controller.post_click(CITY_CLICK_X, click_y).wait()
                time.sleep(SWITCH_SETTLE_DELAY)

                new_image = _screencap(context)
                if new_image is None or getattr(new_image, "size", 0) == 0:
                    _log("DefenseGenerals", f"「{label}」切换后截图失败，换下一城")
                    continue
                new_found, _ = _read_trio_with_retry(
                    context, new_image, TRIO_READ_RETRY, TRIO_READ_INTERVAL, abort
                )
                if not new_found:
                    _log("DefenseGenerals", f"「{label}」守城将名字未刷出来，无法判定 -> 换下一城")
                    continue

                new_hit, new_slot, new_text, new_name = _trio_blocked(new_found, block_list)
                if not new_hit:
                    # 换城选中的城池还需要点「设为目标」确认，管线才能按新城池出征；
                    # 关闭弹窗交给 next 链上的「关闭单刷筛选城池」。
                    _log(
                        "DefenseGenerals",
                        f"城池「{label}」无屏蔽武将（已选中）-> 点击设为目标",
                    )
                    context.tasker.controller.post_click(*SET_TARGET_CLICK).wait()
                    time.sleep(SET_TARGET_SETTLE_DELAY)
                    _log(
                        "DefenseGenerals",
                        f"「{label}」已设为目标 -> 结束检测，交回出征流程（关闭弹窗由管线完成）",
                    )
                    return None
                checked.append(label)
                _log(
                    "DefenseGenerals",
                    f"城池「{label}」也命中屏蔽武将（{new_slot}位 {new_text!r} 命中 {new_name!r}）"
                    " -> 继续下一城",
                )

        _log(
            "DefenseGenerals",
            f"全部城池（含翻页后共检查 {len(checked)} 个命中 + 其余已掠夺/无法判定）"
            "均无干净目标 -> 执行城池刷新",
        )
        return self.AnalyzeResult(
            box=(1040, 540, 80, 40),
            detail={
                "mode": "blocked",
                "result": "all_blocked",
                "checked": current_desc,
                "pages": CITY_PAGE_COUNT,
                "blocked_cities": checked,
            },
        )


# ==========================================================================
# 9. 程序入口
# ==========================================================================


def main() -> None:
    current_file_path = os.path.abspath(__file__)
    current_script_dir = os.path.dirname(current_file_path)

    if os.getcwd() != current_script_dir:
        os.chdir(current_script_dir)
    _log("GiftAgent", f"set cwd: {os.getcwd()}")

    if current_script_dir not in sys.path:
        sys.path.insert(0, current_script_dir)

    Tasker.set_log_dir("./debug")

    if len(sys.argv) < 2:
        print("Usage: python main.py <socket_id>")
        print("socket_id is provided by AgentIdentifier.")
        raise SystemExit(1)

    socket_id = sys.argv[-1]
    # 设备管理系统 monitor 客户端：心跳/查看变量/修改变量/配置变量三通道闭环
    # （后台 daemon 线程，网络失败静默，绝不影响赠礼主流程）
    try:
        import monitor_client

        monitor_client.start()
    except Exception:
        pass
    AgentServer.start_up(socket_id)
    AgentServer.join()
    AgentServer.shut_down()


if __name__ == "__main__":
    main()
