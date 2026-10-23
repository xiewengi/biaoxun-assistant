#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
标讯助手 · 招标公告采集器
================================================
过滤规则（2026-10-21 起生效）：
  1. 城市过滤 = 潮州（标题/采购人/正文必须命中潮州或其区县词；命中汕头「潮阳/潮南」直接剔除）
  2. 时间过滤 = 最近一个月（--days，默认 30）
  3. 关键词过滤 = 定时任务1 关键词表（PRD 预制），命中写入 matchedKeywords

数据源：
  A. 潮州市公共资源交易中心 https://www.czggzy.com:8088 （列表→详情→公告PDF正文）
  B. 中国政府采购网 search.ccgp.gov.cn （有 IP 频控，慢速重试）

输出：announcements.json（demo 字段结构，见 OUT 目标）
用法：python3 collector/collect.py [--days 30] [--source czggzy|ccgp|all] [--no-pdf]
"""
import argparse
import datetime as dt
import http.cookiejar
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "pylibs"))
try:
    from pypdf import PdfReader
    HAS_PDF = True
except Exception:
    HAS_PDF = False

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
CTX = ssl._create_unverified_context()
CJ = http.cookiejar.CookieJar()
OPENER = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(CJ),
    urllib.request.HTTPSHandler(context=CTX),
    urllib.request.HTTPHandler(),
)

# ---------- 过滤配置 ----------

# 城市 = 潮州：必须命中其一
CITY_WORDS = ["潮州", "湘桥", "潮安", "饶平", "枫溪"]
# 汕头辖区（一字之差，必须排除）：命中且不命中潮州词 → 剔除
CITY_BLOCK = ["潮阳", "潮南", "汕头", "澄海", "南澳"]

# 定时任务1 关键词表（PRD）
KEYWORDS = [
    "信息化", "智能化", "弱电", "智慧", "数字", "平台", "系统", "软件", "大数据",
    "云", "机房", "数据中心", "网络", "等保", "网络安全", "监控", "安防", "视频",
    "雪亮", "物联", "5G", "室分", "无线覆盖", "WiFi", "专线", "光缆", "管道",
    "通信", "IDC", "AI", "大模型", "数字人", "无人机", "低空", "一卡通", "门禁",
    "停车", "充电桩", "光伏", "储能", "烟感", "消防物联", "明厨亮灶", "在线监测",
]

# 业务标签（PRD：按标品自动分类）
BUSINESS_TAGS = [
    ("监控", ["监控", "摄像", "视频", "雪亮", "安防"]),
    ("专线", ["专线", "光缆", "通信", "WiFi", "5G"]),
    ("平台", ["平台", "信息化", "智慧", "系统", "软件", "数字", "大数据"]),
    ("机房", ["机房", "数据中心", "IDC"]),
    ("室分", ["室分", "无线覆盖"]),
    ("光伏", ["光伏", "储能", "充电桩"]),
]


# ---------- 默认分派负责人（勿随意改动！）----------
# 新入库公告的 currentHandler 默认值：集团客户部负责人
# 对应前端 TEAM_GROUPS[0].admin（已固定排序第一）
# 若团队管理改动，同步改这里，或改为运行时从 teams.json 读取。
DEFAULT_HANDLER = "佘淑娟"


def log(msg):
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def http_get(url, referer=None, tries=3, delay=1.5, timeout=25):
    headers = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"}
    if referer:
        headers["Referer"] = referer
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with OPENER.open(req, timeout=timeout) as r:
                data = r.read()
                ct = r.headers.get("Content-Type", "")
                return data, ct
        except Exception as e:  # noqa
            last = e
            time.sleep(delay * (i + 1))
    raise last


def html_text(data, ct=""):
    """自动识别编码，返回纯文本。"""
    if "charset=gb" in (ct or "").lower() or data[:2] == b"\xff\xfe"[:2]:
        pass
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            t = data.decode(enc)
            if t.count("�") < len(t) * 0.02:
                return t
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "ignore")


def strip_tags(html):
    html = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    html = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.I)
    html = re.sub(r"<[^>]+>", " ", html)
    html = (html.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">"))
    return re.sub(r"\s+", " ", html).strip()


def clean_title(t):
    """清洗检索结果标题：CJK 间的 <font> 断词空格 + 采购人前缀重复。"""
    t = re.sub(r"(?<=[一-鿿])\s+(?=[一-鿿])", "", t or "")
    # 去重连续重复前缀（如 "潮州市人民医院潮州市人民医院xxx"）
    for k in range(6, min(len(t) // 2, 40)):
        if t[:k] and t[k:2 * k] == t[:k]:
            t = t[k:]
            break
    return t.strip()


# ---------- 过滤器 ----------

def city_filter(*texts):
    """城市=潮州：任一文本命中潮州词，且不落在汕头黑名单。"""
    blob = " ".join(t for t in texts if t)
    has_block = any(w in blob for w in CITY_BLOCK)
    has_city = any(w in blob for w in CITY_WORDS)
    if has_city and not has_block:
        return True
    # 「潮阳」是汕头的，但「潮州市…阳…」等组合少见；只要同时出现潮州词，以潮州为准
    if has_city and has_block and any(w in blob for w in ["潮州市", "潮州"]):
        # 明确潮州市本级或区县词压过汕头词
        return True
    return False


def match_keywords(text):
    return [k for k in KEYWORDS if k in text]


def guess_business_tags(text):
    """返回所有命中的业务标签（多标签），都没命中返回空列表。"""
    hit = [tag for tag, words in BUSINESS_TAGS if any(w in text for w in words)]
    return hit  # [] 或 ["平台", "监控", ...]，顺序即 BUSINESS_TAGS 定义顺序


def guess_district(text):
    for d in ["湘桥", "潮安", "饶平", "枫溪"]:
        if d in text:
            return d
    if "潮州市" in text or "潮州" in text:
        return "市区"  # 市本级/未标区县的归市区（对齐昨天口径）
    return ""


def _parse_contacts_from_content(text):
    """从公告正文（去 HTML 标签后的纯文本）解析三方联系方式。

    支持多种常见结构，广东政采网固定章节优先：
      八、凡对本次采购提出询问，请按以下方式联系。
        1.采购人信息  名 称:...  地 址:...  联系方式:...
        2.采购代理机构信息  名 称:...  地 址:...  联系方式:...
        3.项目联系方式  项目联系人:...  电 话:...

    返回 dict {purchaser, agency, project}，每个子 dict 含 name/address/person/phone。
    空字符串字段表示未解析到。
    """
    if not text:
        return {"purchaser": {}, "agency": {}, "project": {}}

    result = {
        "purchaser": {"name": "", "address": "", "person": "", "phone": ""},
        "agency":    {"name": "", "address": "", "person": "", "phone": ""},
        "project":   {"person": "", "phone": ""},
    }

    # 定位联系方式章节：常见锚点关键词
    anchors = [
        "凡对本次采购提出询问",
        "凡对本次采购提出询问，请按以下方式联系",
        "凡对本次采购提出疑问",
        "请按以下方式联系",
    ]
    anchor_pos = -1
    for a in anchors:
        p = text.find(a)
        if p > 0:
            anchor_pos = p
            break

    if anchor_pos > 0:
        # 取章节块：从锚点后到 3000 字内 / 或到 "附件"/"合同"/"采购人最终" 等结束词
        block_text = text[anchor_pos:anchor_pos + 3000]
        for end_kw in ["相关附件", "附件", "合同", "中标", "成交", "资格预审"]:
            ep = block_text.find(end_kw)
            if ep > 500:
                block_text = block_text[:ep]
        parse_contact_block(block_text, result)
    else:
        # 没有固定联系方式章节，退用宽松正则扫全文
        loose_parse_contacts(text, result)

    return result


def parse_contact_block(block_text, result):
    """解析有明确 1./2./3. 编号的联系方式章节块。"""
    # 按编号分块：1.采购人信息 ... 2.采购代理机构信息 ... 3.项目联系方式
    # 先用正则把三个 section 切出来
    sections = re.split(r'(?=\n?\s*[123]\.\s*(?:采购人信息|采购代理机构信息|采购人代理机构信息|项目联系))',
                        block_text)
    # 或者更宽松：以 \n 1. / \n 2. / \n 3. 开头切
    if len(sections) < 2:
        sections = re.split(r'(?:^|\n)\s*([123])[\.、]\s*(采购人信息|采购代理机构信息|项目联系)',
                            block_text)
        if len(sections) >= 4:
            # re.split with capturing group 会把编号和标题单独作为元素，重新组装
            rebuilt = []
            i = 1
            while i + 1 < len(sections):
                rebuilt.append(sections[i+1].strip())
                i += 2
            sections = rebuilt

    # 识别 section 类型并填充
    for sec in sections:
        sec = sec.strip()
        if not sec: continue
        label = ""
        if "采购人信息" in sec and "代理" not in sec:
            label = "purchaser"
        elif "代理机构" in sec or ("采购人" in sec and "代理" in sec):
            label = "agency"
        elif "项目联系" in sec or "本项目" in sec:
            label = "project"
        else:
            # 兜底：看标题前缀
            title_match = re.match(r'\s*[123][\.、]?\s*(采购人信息|采购代理机构信息|项目联系)', sec)
            if title_match:
                t = title_match.group(1)
                if "代理" in t: label = "agency"
                elif "项目" in t: label = "project"
                else: label = "purchaser"

        if label == "purchaser":
            _fill_org(result["purchaser"], sec)
        elif label == "agency":
            _fill_org(result["agency"], sec)
        elif label == "project":
            _fill_project(result["project"], sec)


def _fill_org(target, text):
    """从一段文本填充 name/address/person/phone。"""
    target["name"]    = target["name"]    or _extract(text, r'名\s*称[：:]\s*([^\s，,。；;\n\r（()）]+)')
    target["address"] = target["address"] or _extract(text, r'地\s*址[：:]\s*([^\s，,。；;\n\r]+)')
    target["phone"]   = target["phone"]   or _extract(text, r'联系方式[：:]\s*([0-9\-+()（）、/]{6,30})')
    if not target["phone"]:
        target["phone"] = target["phone"] or _extract(text, r'电\s*话[：:]\s*([0-9\-+()（）、/]{6,30})')
    target["person"]  = target["person"]  or _extract(text, r'联系人[：:]\s*([^\s，,。；;\n\r]{2,15})')


def _fill_project(target, text):
    """项目联系只有 person + phone。"""
    target["person"] = target.get("person") or _extract(text, r'项目联系人[：:]\s*([^\s，,。；;\n\r]{2,15})')
    target["phone"]  = target.get("phone")  or _extract(text, r'电\s*话[：:]\s*([0-9\-+()（）、/]{6,30})')
    if not target["phone"]:
        target["phone"] = target["phone"] or _extract(text, r'联系电话[：:]\s*([0-9\-+()（）、/]{6,30})')
    if not target["person"]:
        target["person"] = target.get("person") or _extract(text, r'联系人[：:]\s*([^\s，,。；;\n\r]{2,15})')


def _extract(text, pattern):
    """正则提取，match group(1) 去空格去尾部标点。"""
    m = re.search(pattern, text)
    if not m: return ""
    v = m.group(1).strip().strip("：:，,。；;、")
    return v


def loose_parse_contacts(text, result):
    """没找到固定章节时，用宽松正则扫全文——准确率低，有比没有好。"""
    # 采购人：找"采购人"+"名称/联系电话"
    if not result["purchaser"]["name"]:
        m = re.search(r'采购人[^\n]{0,30}?名\s*称[：:]\s*([^\s，,。；;\n]{2,30})', text)
        if m: result["purchaser"]["name"] = m.group(1).strip()
    if not result["purchaser"]["phone"]:
        m = re.search(r'采购人[^\n]{0,50}?联系电话[：:]\s*([0-9\-+()（）]{6,20})', text)
        if m: result["purchaser"]["phone"] = m.group(1).strip()

    # 代理
    if not result["agency"]["name"]:
        m = re.search(r'(?:招标|采购)?[代代]理机构[^\n]{0,30}?名\s*称[：:]\s*([^\s，,。；;\n]{2,30})', text)
        if m: result["agency"]["name"] = m.group(1).strip()

    # 项目
    if not result["project"]["person"]:
        m = re.search(r'(?:项目|本项目)?\s*联系人[：:]\s*([^\s，,。；;\n]{2,15})', text)
        if m: result["project"]["person"] = m.group(1).strip()
    if not result["project"]["phone"]:
        m = re.search(r'(?:项目|本项目)?\s*联系电话[：:]\s*([0-9\-+()（）]{6,20})', text)
        if m: result["project"]["phone"] = m.group(1).strip()


def _extract_purchase_method(text):
    """从公告正文（去HTML后）提取采购方式（公开招标/竞争性磋商/单一来源等）。"""
    if not text: return ""
    # 优先匹配"采购方式"标签
    m = re.search(r"采购方式[：:]\s*([^\s，,。；;（()）]{2,15})", text)
    if m:
        return m.group(1).strip()
    # 兜底：匹配"采购方式：公开招标"这种写法
    m = re.search(r"采购方式[^\n]{0,20}?(公开招标|竞争性磋商|竞争性谈判|单一来源|询价|邀请招标|协议供货|框架协议|定点采购|公开征集)", text)
    if m:
        return m.group(1)
    return ""


# ---------- 源A：潮州市公共资源交易中心 ----------

CZ_BASE = "https://www.czggzy.com:8088"


def cz_list_pages(max_pages=50):
    """遍历正在交易/招标公告/历史公告列表，产出条目 (id, clsid, title, proj_code, bid_start, bid_open)."""
    seen = {}
    for code in ("Z", "G", "H"):
        page = 1
        while page <= max_pages:
            url = f"{CZ_BASE}/indexz.jsp?pageNo={page}&code={code}"
            try:
                data, ct = http_get(url, referer=CZ_BASE + "/")
            except Exception as e:
                log(f"  列表 {code} p{page} 失败: {e}")
                break
            t = html_text(data, ct)
            parts = re.split(r'<table onClick="doBrowser', t)
            if len(parts) < 2:
                break
            oldest = None
            for blk in parts[1:]:
                m = re.match(r"\(\{id:(\d+),clsid:'(\w+)'\}\)", blk)
                if not m:
                    continue
                iid, cls = m.group(1), m.group(2)
                tm = re.search(r'title="([^"]+)"', blk)
                cm = re.search(r"项目编号：([A-Za-z0-9]+)", blk)
                dates = re.findall(r"20\d{2}-\d{2}-\d{2}", blk)
                # 列表页日期顺序：投标开始 / 开标
                bid_start = dates[0] if dates else ""
                bid_open = dates[1] if len(dates) > 1 else ""
                if iid not in seen:
                    seen[iid] = dict(
                        id=iid, cls=cls,
                        title=clean_title(tm.group(1)) if tm else "",
                        project_code=cm.group(1) if cm else "",
                        bid_start=bid_start, bid_open=bid_open,
                        list_text=strip_tags(blk),
                    )
                if bid_start:
                    oldest = bid_start if oldest is None else min(oldest, bid_start)
            # 翻页终止：本页最老日期早于截止期 2 倍窗口就停（H 栏目按时间倒序）
            page += 1
            time.sleep(0.4)
            if code == "H" and oldest and oldest < _days_ago_str(70):
                break
    return list(seen.values())


def _days_ago_str(n):
    return (dt.date.today() - dt.timedelta(days=n)).isoformat()


def cz_detail(item):
    """详情页：采购单位/预算/招标开始/截止/开标 + 公告PDF链接。"""
    url = f"{CZ_BASE}/info.zu.jsp?id={item['id']}&clsid={item['cls']}"
    try:
        data, ct = http_get(url, referer=CZ_BASE + "/")
    except Exception as e:
        log(f"  详情 {item['id']} 失败: {e}")
        return None, ""
    t = html_text(data, ct)

    def field(label):
        m = re.search(label + r"[：:]</td>\s*<td[^>]*>([\s\S]{0,200}?)</td>", t)
        if not m:
            m = re.search(label + r"[：:]</td>\s*<td[^>]*>([\s\S]{0,200}?)</td>", t, re.I)
        if not m:
            # 纯文本形式
            m = re.search(label + r"[：:]\s*([^<\n]{1,120})", t)
        return strip_tags(m.group(1)) if m else ""

    detail = dict(
        buyer=field("采购单位"),
        budget=field("采购预算(或最高限价)"),
        method=field("采购方式"),
        bid_start=field("招标开始时间"),
        deadline=field("招标截止时间"),
        bid_open=field("开标时间"),
        url=url,
    )
    # PDF 正文链接
    m = re.search(r'src="(paper\.view\.jsp\?[^"]+)"', t)
    pdf_url = ""
    if m:
        try:
            pv, ct2 = http_get(f"{CZ_BASE}/{m.group(1)}", referer=url)
            pt = html_text(pv, ct2)
            pm = re.search(r'file=(/Attach/[^"&]+\.pdf)', pt)
            if pm:
                pdf_url = CZ_BASE + urllib.parse.unquote(pm.group(1))
        except Exception as e:
            log(f"  paper {item['id']} 失败: {e}")
    return detail, pdf_url


OCR_DIR = os.path.join(BASE, "collector", "_ocr")
TESSERACT = "/opt/homebrew/bin/tesseract"


def ocr_pdf(path, max_pages=3):
    """扫描件 PDF（无文本层）→ 逐页图片 → tesseract chi_sim OCR。"""
    if not os.path.exists(TESSERACT):
        return ""
    try:
        from PIL import Image  # noqa
    except Exception:
        return ""
    os.makedirs(OCR_DIR, exist_ok=True)
    out = []
    try:
        r = PdfReader(path)
        for i, pg in enumerate(r.pages[:max_pages]):
            try:
                imgs = list(pg.images)
            except Exception:
                imgs = []
            if not imgs:
                continue
            raw = imgs[0].data
            src = os.path.join(OCR_DIR, f"p{i}.img")
            with open(src, "wb") as f:
                f.write(raw)
            dst = os.path.join(OCR_DIR, f"p{i}")
            try:
                subprocess.run(
                    [TESSERACT, src, dst, "-l", "chi_sim", "--psm", "6"],
                    check=True, capture_output=True, timeout=60,
                )
                with open(dst + ".txt", encoding="utf-8", errors="ignore") as f:
                    out.append(f.read())
            except Exception as e:
                log(f"    OCR p{i} 失败: {e}")
            finally:
                for p_ in (src, dst + ".txt"):
                    try:
                        os.remove(p_)
                    except OSError:
                        pass
    except Exception as e:
        log(f"  OCR 整体失败: {e}")
    return "\n".join(out)


def pdf_text(url):
    if not HAS_PDF or not url:
        return ""
    try:
        data, _ = http_get(url, referer=CZ_BASE + "/", timeout=40)
        path = "/tmp/_cz_ann.pdf"
        with open(path, "wb") as f:
            f.write(data)
        r = PdfReader(path)
        txt = "\n".join((p.extract_text() or "") for p in r.pages[:5])
        if len(txt.strip()) < 40:
            txt = ocr_pdf(path)
        return txt
    except Exception as e:
        log(f"  PDF 解析失败 {e}")
        return ""


# ---------- 源B：中国政府采购网 ----------

def ccgp_search(days):
    """search.ccgp.gov.cn 关键词=潮州 + 时间窗。返回原始条目列表。"""
    start = (dt.date.today() - dt.timedelta(days=days)).strftime("%Y/%m/%d")
    end = dt.date.today().strftime("%Y/%m/%d")
    kw = urllib.parse.quote("潮州")
    out = []
    for pn in (1, 2, 3):
        url = ("http://search.ccgp.gov.cn/bxsearch?searchtype=1&page_index=1"
               f"&bidSort=0&buyerName=&projectId=&pinMu=0&bidType=0&dbselect=bidx"
               f"&kw={kw}&start_time={start}&end_time={end}&timeType=6&platformId=&pn={pn}")
        try:
            data, ct = http_get(url, referer="http://search.ccgp.gov.cn/", tries=2, delay=6)
        except Exception as e:
            log(f"  ccgp p{pn} 失败: {e}")
            continue
        t = html_text(data, ct)
        if "频繁访问" in t:
            log(f"  ccgp p{pn} 触发频控，跳过")
            continue
        for m in re.finditer(
            r'<a[^>]+href="(https?://[^"]+)"[^>]*>([\s\S]{0,300}?)</a>([\s\S]{0,400}?)(20\d\d-\d\d-\d\d)',
            t,
        ):
            link, title_html, mid, date = m.groups()
            title = strip_tags(title_html)
            if len(title) < 8 or "ccgp.gov.cn" not in link:
                continue
            ctx = strip_tags(mid)
            out.append(dict(title=title, url=link, date=date, context=ctx))
        time.sleep(4)
    return out


# ---------- 源C：广东省政府采购网（全文检索，免网关签名） ----------

GD_BASE = "https://gdgpo.czt.gd.gov.cn"
GD_SITE = "cd64e06a-21a7-4620-aebc-0576bab7e07a"
GD_CHANNEL = "fca71be5-fc0c-45db-96af-f513e9abda9d,95ff31f3-a1af-4bc4-b1a2-54c894476193"
# 潮州区划码：445101市本级 445102湘桥 445103潮安 445122饶平
GD_CITY_CODES = ("4451",)


def _gd_json(path, params):
    q = dict(params)
    q["_t"] = int(time.time() * 1000)
    url = f"{GD_BASE}{path}?" + urllib.parse.urlencode(q)
    data, _ = http_get(url, referer=f"{GD_BASE}/maincms-web/fullSearchingGd")
    return json.loads(data)


def gd_notice_type_map():
    try:
        d = _gd_json("/gpcms/rest/web/v2/index/getDictInfo",
                     {"dictType": "xxcg-noticeType", "site": GD_SITE})
        return {r["dictCode"]: r["dictName"] for r in d.get("data") or []}
    except Exception as e:
        log(f"  类型字典失败: {e}")
        return {}


def gd_search(days, search_key="潮州"):
    """全文检索：searchKey=关键词，时间窗=最近 N 天。分页拉全。"""
    start = (dt.date.today() - dt.timedelta(days=days)).strftime("%Y-%m-%d 00:00:00")
    end = dt.date.today().strftime("%Y-%m-%d 23:59:59")
    rows, page, total = [], 1, None
    while page <= 30:
        d = _gd_json("/gpcms/rest/web/v2/info/selectInfoForIndex", dict(
            currPage=page, pageSize=40, siteId=GD_SITE, channel=GD_CHANNEL,
            operationStartTime=start, operationEndTime=end, searchKey=search_key,
            selectTimeName="noticeTime", requestSource="qwjs",
        ))
        data = d.get("data") or {}
        got = data.get("rows") or []
        rows += got
        total = data.get("total") or 0
        if not got or len(rows) >= total:
            break
        page += 1
        time.sleep(0.3)
    return rows


def gd_detail(row):
    """详情：正文 content / 联系方式 / 开标时间等。"""
    d = _gd_json("/gpcms/rest/web/v2/info/getInfoById",
                 {"channel": row.get("channel"), "site": GD_SITE, "id": row.get("id")})
    return (d.get("data") or {})


def run_gdgpo(days, with_detail=True):
    log(f"源C 广东省政府采购网：全文检索 searchKey=潮州 近{days}天…")
    try:
        rows = gd_search(days)
    except Exception as e:
        log(f"  源C 检索失败: {e}")
        return []
    log(f"  检索命中 {len(rows)} 条")
    tmap = gd_notice_type_map()
    recs = []
    skipped_type = [0]
    for i, row in enumerate(rows):
        title = clean_title(strip_tags(row.get("title") or ""))
        buyer = row.get("purchaser") or row.get("author") or ""
        region = str(row.get("regionCode") or "")
        # ---- 城市=潮州（区划码 + 文本双保险） ----
        if not region.startswith(GD_CITY_CODES) and not city_filter(title, buyer, row.get("regionName") or ""):
            continue
        if any(w in (title + buyer + (row.get("regionName") or "")) for w in ["汕头", "潮阳", "潮南"]) \
                and not region.startswith(GD_CITY_CODES):
            continue
        pub = (row.get("noticeTime") or "")[:10]
        try:
            if pub and dt.date.fromisoformat(pub) < dt.date.today() - dt.timedelta(days=days):
                continue
        except ValueError:
            pass
        # ---- 类型白名单：只收 采购需求/采购公告/招标公告（中标、更正、合同、计划、意向都不收） ----
        ann_type = _gd_ann_type(str(row.get("noticeType") or ""), tmap)
        if not type_allowed(ann_type):
            skipped_type[0] += 1
            continue
        content = ""
        contact = ""
        if with_detail:
            if i % 10 == 0:
                log(f"  详情 {i+1}/{len(rows)}…")
            try:
                det = gd_detail(row)
            except Exception as e:
                log(f"  详情失败 {row.get('id')}: {e}")
                det = {}
            time.sleep(0.25)
            raw_content = strip_tags(det.get("content") or "")
            # 联系方式正则需要完整正文（章节在末尾），不能截短
            _base = {
                "purchaser": {"name": "", "address": "", "person": "", "phone": ""},
                "agency":    {"name": "", "address": "", "person": "", "phone": ""},
                "project":   {"person": "", "phone": ""},
            }
            if with_detail:
                parsed = _parse_contacts_from_content(raw_content)
                # 合并：parsed 覆盖 _base（空字符串保留默认值）
                for k in _base:
                    if isinstance(parsed.get(k), dict):
                        _base[k].update(parsed[k])
            contacts = _base
            # content 截短只用于 summary/keyword 匹配，不影响 contact 解析
            content = raw_content[:3000]
            # API 字段只填正文没抠到的空字段（优先 det，兜底 row）
            if with_detail:
                def api(*keys):
                    for k in keys:
                        v = det.get(k) or row.get(k)
                        if v: return str(v).strip()
                    return ""
                p = contacts["purchaser"]
                p["name"]    = p["name"]    or api("purchaser")
                p["address"] = p["address"] or api("purchaserAddr")
                p["phone"]   = p["phone"]   or api("purchaserLinkPhone")
                p["person"]  = p["person"]  or api("purchaserLinkMan")
                a = contacts["agency"]
                a["name"]    = a["name"]    or api("agency")
                a["address"] = a["address"] or api("agentAddress")
                a["phone"]   = a["phone"]   or api("agentLinkPhone")
                a["person"]  = a["person"]  or api("agentLinkMan", "agentManageName", "agentPrincipalName")
                prj = contacts["project"]
                prj["phone"]  = prj.get("phone")  or api("contactNumber")
                prj["person"] = prj.get("person") or api("contactPerson")
            # 扁平 contact（旧逻辑兼容）
            purchaser = contacts["purchaser"]
            agency_info = contacts["agency"]
            project = contacts["project"]
            flat_contact = " ".join(x for x in [
                purchaser.get("phone"), agency_info.get("phone"),
                project.get("person"), project.get("phone"),
            ] if x)
        blob = " ".join([title, buyer, row.get("agency") or "", row.get("catalogueNameList") or "", content])
        kws = match_keywords(blob)
        if not kws:
            continue
        detail_url = f"{GD_BASE}/maincms-web/noticeGd?type=notice&id={row.get('id')}" \
                     f"&channel={row.get('channel') or ''}"
        budget = row.get("budget")
        # 时间提取：先用 row（搜索接口），再 fallback 到 det（详情接口，已在 L467 拉取但之前没用），
        # 最后 deadline 兜底用 openTenderTime —— 广东省政府采购网的采购公告/竞争性磋商公告通常
        # 报名截止 = 开标时间，API 层面就没拆开，接口上 noticeEndTime/endTime 全是 None。
        open_time = (row.get("openTenderTime") or (det.get("openTenderTime") if with_detail else "") or "—")[:10]
        end_time = (row.get("noticeEndTime") or "" or
                    (det.get("noticeEndTime") if with_detail else "") or
                    (det.get("endTime") if with_detail else "") or "")[:10]
        deadline = end_time or open_time  # 兜底：报名截止=开标时间
        rec = build_record(
            title=title,
            summary=(content[:300] or f"{buyer} {row.get('catalogueNameList') or ''}"),
            source_url=detail_url,
            pub_date=pub,
            deadline=deadline or "—",
            bid_open=open_time or "—",
            buyer=buyer,
            agency=row.get("agency") or "—",
            budget=(f"{float(budget):,.2f}元" if budget not in (None, "") else "—"),
            project_code=row.get("openTenderCode") or row.get("planCodes") or "—",
            contact=(flat_contact if with_detail else "") or "—",
            contacts=contacts if with_detail else {},
            ann_type=ann_type,
            extra_text=blob,
            purchase_method=_extract_purchase_method(content),
        )
        if rec:
            rec["district"] = _gd_district(region, row.get("regionName") or "") or rec["district"]
            recs.append(rec)
    log(f"  源C 通过过滤 {len(recs)} 条（类型白名单外剔除 {skipped_type[0]} 条）")
    return recs


# 类型白名单（老大 2026-10-21 定）：只收 采购需求 / 采购公告 / 招标公告；
# 中标(成交)结果、更正/修正、合同、验收、采购计划、采购意向等一律不收。
TYPE_WHITELIST = ("采购需求", "采购公告", "招标公告")


def type_allowed(ann_type):
    """类型是否属于采集范围：命中白名单关键词即收。"""
    t = ann_type or ""
    return any(k in t for k in TYPE_WHITELIST)


def _gd_ann_type(code, tmap):
    """公告类型：字典直查 + 前缀归并（00101x=采购公告 00102x=结果公告 00103x=更正）。"""
    if code in tmap:
        return tmap[code]
    if code.startswith("00101"):
        return "采购公告"
    if code.startswith("00102"):
        return "中标(成交)结果公告"
    if code.startswith("00103"):
        return "更正公告"
    if code.startswith("00105"):
        return "采购合同/验收"
    return "其他公告"


def _gd_district(code, name):
    """区划码→demo 区县（对齐昨天口径：湘桥/潮安/饶平/枫溪/市区）。"""
    m = {"445101": "市区", "445102": "湘桥", "445103": "潮安", "445122": "饶平"}
    if code in m:
        return m[code]
    for d in ["湘桥", "潮安", "饶平", "枫溪"]:
        if d in name:
            return d
    if "市本级" in name:
        return "市区"
    return ""


# ---------- 组装 demo 数据结构 ----------

ANN_SUFFIX_RE = re.compile(
    r'\s*(公开招标公告|招标公告|竞争性磋商公告|竞争性谈判公告|询价公告|'
    r'单一来源采购公示|中标公告|成交公告|流标公告|变更公告|更正公告|'
    r'资格预审公告|公开招标文件|招标公告)$'
)

def extract_project_name(title, summary):
    """从 summary 优先提取"项目名称：XXX"，失败则从 title 去除公告后缀。"""
    if summary:
        m = re.search(r'项目名称[：:]\s*([^\s，,。]+)', summary)
        if m:
            return m.group(1).strip()
    if title:
        t = re.sub(r'[（(].*[）)]\s*$', '', title).strip()
        t = ANN_SUFFIX_RE.sub('', t).strip()
        if t:
            return t
    return title or ""


def build_record(title, summary, source_url, pub_date, deadline="", bid_open="",
                 buyer="", agency="", budget="", project_code="", contact="",
                 contacts=None,
                 ann_type="招标公告", fund_source="", extra_text="",
                 purchase_method=""):
    """组装 demo 公告记录（字段见 PRD 招标公告展示）。返回 None 表示未通过过滤。

    contacts: 结构化联系方式对象 {purchaser:{name,address,person,phone},
               agency:{...}, project:{...}}，前端详情页分三方展示。
    """
    blob = " ".join([title, summary, buyer, agency, extra_text])
    if not city_filter(title, summary, buyer, extra_text):
        return None
    kws = match_keywords(blob)
    if not kws:
        return None
    now = dt.date.today().isoformat()
    project_name = extract_project_name(title, summary)
    return dict(
        id="ANN" + (pub_date or now).replace("-", "") + f"{abs(hash(title)) % 10000:04d}",
        title=title,
        projectName=project_name,
        projectCode=project_code or f"P{abs(hash(title + source_url)) % 900000 + 100000}",
        buyer=buyer or "—",
        agency=agency or "—",
        budget=budget or "—",
        fundSource=fund_source or "—",
        district=guess_district(title + " " + buyer + " " + extra_text),
        annType=ann_type,
        pubDate=pub_date,
        deadline=deadline or "—",
        bidOpenDate=bid_open or "—",
        summary=summary[:300] if summary else "—",
        contact=contact or "—",
        contacts=contacts or {},
        sourceUrl=source_url,
        matchedKeywords=kws,
        businessTags=guess_business_tags(blob),
        region="潮州",
        purchaseMethod=purchase_method or "—",
        isValidOpportunity="",
        hasOperatorInvolvement="",
        opportunityCode="",
        opportunityStatus="",
        willBid="",
        treePlacement="",
        currentHandler=DEFAULT_HANDLER,
        createdAt=now,
        nextFollowUp=(dt.date.today() + dt.timedelta(days=2)).isoformat(),
        progress="待分配",
        progressRecords=[dict(progress="待分配", follower="系统",
                              followDate=now, note="新公告自动入库")],
    )


# ---------- 主流程 ----------

def cz_construction(days):
    """建设工程招标公告（indexj.jsp, clsid=J，详情 info.u.jsp）。"""
    cutoff = dt.date.today() - dt.timedelta(days=days)
    recs = []
    for code in ("J", "H"):
        for page in (1, 2, 3):
            try:
                data, ct = http_get(f"{CZ_BASE}/indexj.jsp?pageNo={page}&code={code}",
                                    referer=CZ_BASE + "/")
            except Exception as e:
                log(f"  建设 {code} p{page} 失败: {e}")
                break
            t = html_text(data, ct)
            cells = re.split(r'<li class="cells">', t)[1:]
            if not cells:
                break
            stop = False
            for blk in cells:
                m = re.search(r"doBrowser\(\{id:(\d+),clsid:'J'\}\)", blk)
                if not m:
                    continue
                iid = m.group(1)
                tm = re.search(r'<h4[^>]*>([\s\S]{5,200}?)</h4>', blk)
                title = clean_title(strip_tags(tm.group(1))) if tm else ""
                bm = re.search(r"招标编号：</td>\s*<td>([^<]+)</td>", blk)
                dates = re.findall(r"20\d{2}-\d{2}-\d{2}", blk)
                if not title:
                    continue
                pub = dates[0] if dates else ""
                try:
                    if pub and dt.date.fromisoformat(pub) < cutoff:
                        stop = True
                        continue
                except ValueError:
                    pass
                if not city_filter(title, strip_tags(blk)):
                    continue
                # 详情页：招标人/代理/控制价
                url = f"{CZ_BASE}/info.u.jsp?id={iid}&clsid=J"
                try:
                    dd, dct = http_get(url, referer=CZ_BASE + "/")
                    dtxt = html_text(dd, dct)
                except Exception as e:
                    log(f"  建设详情 {iid} 失败: {e}")
                    continue
                time.sleep(0.4)
                pl = re.search(r"招标人：</td>\s*<td[^>]*>([\s\S]{0,150}?)</td>", dtxt)
                al = re.search(r"代理机构：</td>\s*<td[^>]*>([\s\S]{0,150}?)</td>", dtxt)
                bl = re.search(r"招标控制价：</td>\s*<td[^>]*>([\s\S]{0,80}?)</td>", dtxt)
                dl = re.search(r"招标截止时间：</td>\s*<td[^>]*>([\s\S]{0,40}?)</td>", dtxt)
                ol = re.search(r"开标时间：</td>\s*<td[^>]*>([\s\S]{0,40}?)</td>", dtxt)
                buyer = strip_tags(pl.group(1)) if pl else ""
                agency = strip_tags(al.group(1)) if al else ""
                budget = strip_tags(bl.group(1)) if bl else ""
                deadline = strip_tags(dl.group(1))[:10] if dl else ""
                bid_open = strip_tags(ol.group(1))[:10] if ol else ""
                # 正文 PDF
                pm = re.search(r'src="(paper\.view\.jsp\?[^"]+)"', dtxt)
                text = ""
                if pm:
                    try:
                        pv, pct = http_get(f"{CZ_BASE}/{pm.group(1)}", referer=url)
                        pt = html_text(pv, pct)
                        fm = re.search(r'file=(/Attach/[^"&]+\.pdf)', pt)
                        if fm:
                            text = pdf_text(CZ_BASE + urllib.parse.unquote(fm.group(1)))
                    except Exception as e:
                        log(f"  建设PDF {iid}: {e}")
                    time.sleep(0.4)
                blob = title + " " + buyer + " " + agency + " " + text[:1500]
                kws = match_keywords(blob)
                if not kws:
                    continue
                recs.append(dict(
                    id="ANN" + (pub or "").replace("-", "") + iid,
                    title=title,
                    projectCode=(bm.group(1).strip() if bm else f"CZ-J-{iid}"),
                    buyer=buyer or "—",
                    agency=agency or "—",
                    budget=budget or "—",
                    fundSource="—",
                    district=guess_district(title + " " + buyer),
                    annType="建设工程招标公告",
                    pubDate=pub or dt.date.today().isoformat(),
                    deadline=deadline or "—",
                    bidOpenDate=bid_open or "—",
                    summary=(text[:300] if text else strip_tags(blk)[:300]),
                    contact=_find_contact(text) or "—",
                     contacts=_parse_contacts_from_content(text) if text else {},
                    sourceUrl=url,
                    matchedKeywords=kws,
                    businessTags=guess_business_tags(blob),
                    region="潮州",
                    currentHandler=DEFAULT_HANDLER,
                    createdAt=dt.date.today().isoformat(),
                    nextFollowUp=(dt.date.today() + dt.timedelta(days=2)).isoformat(),
                    progress="待分配",
                    progressRecords=[dict(progress="待分配", follower="系统",
                                          followDate=dt.date.today().isoformat(),
                                          note="新公告自动入库")],
                ))
            time.sleep(0.4)
            if stop:
                break
    return recs


def run_czggzy(days, use_pdf=True):
    log(f"源A 潮州交易中心：拉列表…")
    items = cz_list_pages()
    log(f"  列表条目 {len(items)}")
    cutoff = dt.date.today() - dt.timedelta(days=days)
    kept = 0
    recs = []
    for it in items:
        # 先用列表页文本做粗过滤
        if not city_filter(it["title"], it["list_text"]):
            continue
        bid_start = it["bid_start"]
        try:
            bd = dt.date.fromisoformat(bid_start) if bid_start else None
        except ValueError:
            bd = None
        if bd and bd < cutoff:
            continue
        detail, pdf_url = cz_detail(it)
        time.sleep(0.5)
        if detail is None:
            continue
        text = pdf_text(pdf_url) if (use_pdf and pdf_url) else ""
        time.sleep(0.4)
        # 二次过滤：正文（PDF 不可得时退回列表文本）
        check = text or it["list_text"] + " " + detail["buyer"]
        if not city_filter(it["title"], check, detail["buyer"]):
            continue
        pub = detail["bid_start"][:10] if detail["bid_start"] else (bid_start or "")
        if not pub:
            pub = dt.date.today().isoformat()
        try:
            if dt.date.fromisoformat(pub) < cutoff:
                continue
        except ValueError:
            pass
        # 联系方式：PDF 正文 → 三方结构化 contacts；fallback 到详情页字段
        contacts = _parse_contacts_from_content(text) if text else {"purchaser": {}, "agency": {}, "project": {}}
        # czggzy 详情页有 buyer（采购人），agency 固定是潮州市公共资源交易中心
        if not contacts["purchaser"].get("name") and detail.get("buyer"):
            contacts["purchaser"]["name"] = detail["buyer"]
        if not contacts["agency"].get("name"):
            contacts["agency"]["name"] = "潮州市公共资源交易中心"
        # 扁平 contact 兜底（旧逻辑兼容）
        flat_contact = _find_contact(text) or " ".join(x for x in [
            contacts["project"].get("person"),
            contacts["project"].get("phone"),
            contacts["agency"].get("phone"),
        ] if x)
        # budget：HTML 抽不到时从 PDF 正文正则兜底（PDF 嵌页型公告 HTML 常缺 budget）
        budget = detail["budget"]
        if not budget and text:
            bm = re.search(r"预算金额\s*[：:]\s*([0-9,，]+\.?[0-9]*元)", text)
            if not bm: bm = re.search(r"最高限价[^\d]{0,20}([0-9,，]+\.?[0-9]*元)", text)
            if not bm: bm = re.search(r"预算[^\d]{0,20}([0-9,，]+\.?[0-9]*元)", text)
            if bm: budget = bm.group(1).replace("，", ",")
        rec = build_record(
            title=it["title"],
            summary=(text[:300] if text else it["list_text"][:300]),
            source_url=detail["url"],
            pub_date=pub,
            deadline=detail["deadline"][:10],
            bid_open=detail["bid_open"][:10],
            buyer=detail["buyer"],
            agency="潮州市公共资源交易中心",
            budget=budget,
            project_code=it["project_code"],
            contact=flat_contact,
            contacts=contacts,
            ann_type="招标公告",
            extra_text=it["list_text"] + " " + text[:2000],
        )
        if rec:
            recs.append(rec)
            kept += 1
    log(f"  源A 通过过滤 {kept} 条")
    try:
        cons = cz_construction(days)
        log(f"  源A2 建设工程通过过滤 {len(cons)} 条")
        recs += cons
    except Exception as e:
        log(f"  源A2 建设工程失败: {e}")
    return recs


def _find_contact(text):
    m = re.search(r"(联系人[：:]\s*[^\s，,。]{2,10})", text)
    c = m.group(1) if m else ""
    m2 = re.search(r"(联系电话[：:]\s*[0-9\-+()（）]{6,20})", text)
    if m2:
        c = (c + " " + m2.group(1)).strip()
    return c


def run_ccgp(days):
    log("源B 中国政府采购网：搜索…")
    try:
        items = ccgp_search(days)
    except Exception as e:
        log(f"  源B 失败: {e}")
        return []
    log(f"  搜索结果 {len(items)}")
    recs = []
    for it in items:
        if not city_filter(it["title"], it.get("context", "")):
            continue
        rec = build_record(
            title=it["title"],
            summary=it.get("context", "")[:300],
            source_url=it["url"],
            pub_date=it["date"],
            agency="中国政府采购网",
            extra_text=it.get("context", ""),
        )
        if rec:
            recs.append(rec)
    log(f"  源B 通过过滤 {len(recs)} 条")
    return recs


def inject_single_file(recs):
    """把数据注入单文件版 demo 的 INLINE_ANN（今日已清空为 []）。"""
    path = os.path.join(BASE, "标讯助手demo.html")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        html = f.read()
    payload = json.dumps(recs, ensure_ascii=False, indent=1)
    # 注意：re.sub 的替换串里 \n 等转义会被二次解释，必须用函数替换
    new_html, n = re.subn(
        r"const INLINE_ANN = \[[\s\S]*?\];",
        lambda m: "const INLINE_ANN = " + payload + ";",
        html, count=1,
    )
    if n:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_html)
        log(f"写入 {path}（INLINE_ANN {len(recs)} 条）")
    else:
        log(f"!! 未找到 INLINE_ANN 边界，跳过 {path}")


SOURCES_JSON = os.path.join(BASE, "collector", "sources.json")

# ---------- Generic 站点适配器（Tier A/B 通用） ----------
# 首页抓公告链接 → 详情页用通用正则抠字段 → 走 build_record 过滤
ANN_LINK_HREF_RE = re.compile(r"""<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{8,120})</a>""", re.I)
ZB_KEYWORD_RE = re.compile(r"(招标|采购|公告|中标|询价|磋商|谈判|投标|资格预审|中标候选人|变更|更正|单一来源|废标|流标|成交|遴选|邀请招标|定点)", re.I)
DATE_RE = re.compile(r"(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)\s*(\d{1,2}:\d{2})?")
DATE_META_RE = re.compile(r"发布(?:时间|日期)[:：]?[^>]*>[^<]*<[^>]*>(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})")

def _guess_ann_type(title, html):
    t = title or ""
    # 先排除结果类公告（不进白名单），后面 build_record 的 type_allowed 会过滤
    for bad in ["结果公告", "中标公告", "成交公告", "中标候选人公示", "候选人公示",
                "更正公告", "变更公告", "废标公告", "流标公告", "终止公告",
                "合同公告", "验收公告", "单一来源公示"]:
        if bad in t: return bad  # type_allowed 返回 False，被自动剔除
    for suffix in ["单一来源公示", "邀请公告", "变更公告", "更正公告", "废标公告", "流标公告"]:
        if suffix in t: return suffix.replace("公示", "公告")
    for suffix in ["竞争性磋商公告", "竞争性谈判公告", "询价公告", "资格预审公告", "中标公告", "成交公告"]:
        if suffix in (title or ""): return suffix
    if re.search(r"(公开)?招标公告", title or ""): return "招标公告"
    if "采购" in (title or "") and "公告" in (title or ""): return "采购公告"
    return "采购公告"

def _parse_date(html):
    m = DATE_META_RE.search(html or "")
    raw = m.group(1) if m else ""
    if not raw:
        for m2 in DATE_RE.finditer(html or ""):
            raw = m2.group(1); break
        else: return ""
    raw = raw.replace("年","-").replace("月","-").replace("日","").replace("/","-")
    parts = [p for p in raw.split("-") if p]
    if len(parts) >= 3:
        try:
            y, mo, d = int(parts[0]), int(parts[1]), int(parts[2])
            if 2020 <= y <= 2040 and 1 <= mo <= 12 and 1 <= d <= 31:
                return f"{y}-{mo:02d}-{d:02d}"
        except: pass
    return ""

def _parse_deadline(html):
    for pat in [
        r"(?:投标截止|提交文件截止|截[止交]时间|报名截止)[^0-9]{0,10}(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?\s*\d{1,2}:\d{2})",
        r"(?:投标截止|报名截止)[^0-9]{0,10}(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})",
    ]:
        m = re.search(pat, html or "")
        if m: return m.group(1).replace("年","-").replace("月","-").replace("日","").replace("/","-")
    return ""

def _parse_detail_fields(html):
    title_m = re.search(r"<title>([^<]{10,150})</title>", html or "", re.I)
    title = title_m.group(1).strip() if title_m else ""
    if " - " in title: title = title.rsplit(" - ", 1)[0].strip()
    fields = dict(title=title, project_code="", buyer="", agency="", budget="",
                  purchase_method="", ann_type="采购公告")
    pc = re.search(r"(?:项目编号|招标编号|采购编号|项目代码)[：:]\s*([A-Z0-9\-【】\[\]()（）]{3,40})", html or "")
    if pc: fields["project_code"] = pc.group(1)
    b = re.search(r"(?:预算金额|最高限价|预算|采购预算|控制价)[^0-9]{0,15}([\d,]+(?:\.\d+)?)\s*元", html or "")
    if not b:
        b = re.search(r"<td[^>]*>[^<]*(?:预算|限价|控制价)[^<]*</td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?)\s*元?", html or "", re.I)
    if b: fields["budget"] = b.group(1).replace(",", "")
    buy = re.search(r"(?:采购人|招标人|采购单位|业主|建设单位)[：:]\s*([^\s，,。；;（）()<]{2,40})", html or "")
    if not buy: buy = re.search(r"<td[^>]*>[^<]*(?:采购人|招标人|业主)[^<]*</td>\s*<td[^>]*>([^<]{2,40})", html or "", re.I)
    if buy: fields["buyer"] = buy.group(1).strip()
    ag = re.search(r"(?:代理机构|招标代理|采购代理|招标机构)[：:]\s*([^\s，,。；;（）()<]{2,40})", html or "")
    if not ag: ag = re.search(r"<td[^>]*>[^<]*(?:代理机构|招标代理)[^<]*</td>\s*<td[^>]*>([^<]{2,40})", html or "", re.I)
    if ag: fields["agency"] = ag.group(1).strip()
    fields["purchase_method"] = _extract_purchase_method(html or "") or ""
    fields["ann_type"] = _guess_ann_type(title, html or "")
    return fields

def run_generic(site, days=30):
    from urllib.parse import urljoin
    url = site["url"].rstrip("/")
    name = site["name"]
    results = []
    try:
        data, ct = http_get(url, timeout=15)
        html = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else str(data)
    except Exception as e:
        log(f"  {name}: 首页请求失败 {type(e).__name__}")
        return results
    anchors = []
    for m in ANN_LINK_HREF_RE.finditer(html):
        href, txt = m.group(1), m.group(2).strip()
        if not href.startswith("http"): href = urljoin(url + "/", href)
        if any(x in href for x in [".jpg", ".png", ".gif", ".css", ".js", "#", "javascript:", "mailto:"]):
            continue
        if not ZB_KEYWORD_RE.search(txt): continue
        anchors.append((href, txt))
    if not anchors:
        log(f"  {name}: 零候选链接（SPA 空壳或反爬，跳过）")
        return results
    log(f"  {name}: {len(anchors)} 条候选 → 遍历详情页...")
    cutoff = dt.date.today() - dt.timedelta(days=days)
    seen_urls = set()
    for href, anchor_txt in anchors[:40]:
        if href in seen_urls: continue
        seen_urls.add(href)
        try:
            d2, ct2 = http_get(href, timeout=12)
            h2 = d2.decode("utf-8", errors="replace") if isinstance(d2, bytes) else str(d2)
        except Exception: continue
        pub_date = _parse_date(h2)
        if not pub_date: continue
        try:
            pd = dt.date.fromisoformat(pub_date)
            if pd < cutoff: continue
        except: pass
        fields = _parse_detail_fields(h2)
        if not fields["title"]: continue
        rec = build_record(
            title=fields["title"], summary=strip_tags(h2)[:800], source_url=href,
            pub_date=pub_date, deadline=_parse_deadline(h2), bid_open="",
            buyer=fields["buyer"], agency=fields["agency"],
            budget=fields["budget"], project_code=fields["project_code"],
            contact="", contacts=_parse_contacts_from_content(h2),
            ann_type=fields["ann_type"], fund_source="",
            extra_text=strip_tags(h2)[:5000],
            purchase_method=fields["purchase_method"],
        )
        if rec: results.append(rec)
    log(f"  {name}: {len(anchors)} 候选 → {len(results)} 条通过")
    return results

def run_all_generic(days=30):
    sites = load_sources()
    generic_sites = [s for s in sites if s.get("sourceCode", "generic") == "generic"]
    log(f"Generic 适配器：{len(generic_sites)} 个站点待采（days={days}）")
    all_recs = []
    for site in generic_sites:
        try:
            recs = run_generic(site, days=days)
            all_recs.extend(recs)
        except Exception as e:
            log(f"  {site['name']}: 异常 {type(e).__name__} {str(e)[:60]}")
    log(f"Generic 合计: {len(all_recs)} 条（{len(generic_sites)} 站点汇总）")
    return all_recs

SOURCE_DISPATCH = {
    "czggzy":  lambda days, args: run_czggzy(days, use_pdf=not args.no_pdf),
    "ccgp":    lambda days, args: run_ccgp(days),
    "gdgpo":   lambda days, args: run_gdgpo(days, with_detail=not args.no_detail),
    "generic": lambda days, args: run_all_generic(days),
}


def load_sources():
    """从 collector/sources.json 读启用中的数据源列表。"""
    if not os.path.exists(SOURCES_JSON):
        log(f"!! sources.json 不存在：{SOURCES_JSON}")
        return []
    with open(SOURCES_JSON, "r", encoding="utf-8") as f:
        arr = json.load(f)
    return [s for s in arr if s.get("enabled", True)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="最近N天（默认30）")
    ap.add_argument("--source", default="all",
                    help="指定单个源（czggzy/ccgp/gdgpo/generic），或 all=按 sources.json 启用项自动跑（含 generic 47 站）")
    ap.add_argument("--no-pdf", action="store_true", help="跳过公告PDF正文解析")
    ap.add_argument("--no-detail", action="store_true", help="跳过政采网详情正文")
    ap.add_argument("--out", default="", help="仅输出到该路径（默认三处同步）")
    args = ap.parse_args()

    # 确定要跑哪些 sourceCode
    if args.source and args.source != "all":
        codes = [args.source]
        log(f"--source 手动指定：{codes}")
    else:
        sources = load_sources()
        # 收集启用的 sourceCode，generic 等暂无可实现的跳过
        codes = []
        seen = set()
        for s in sources:
            c = s.get("sourceCode", "generic")
            if c in seen:
                continue
            seen.add(c)
            codes.append(c)
        log(f"从 sources.json 加载 {len(sources)} 个启用站点 → 待跑源 {codes}（generic={sum(1 for s in sources if s.get('sourceCode','generic')=='generic')} 个站点）")

    recs = []
    for code in codes:
        fn = SOURCE_DISPATCH.get(code)
        if not fn:
            log(f"!! sourceCode={code} 未在 SOURCE_DISPATCH 注册，跳过")
            continue
        try:
            recs += fn(args.days, args)
        except Exception as e:
            log(f"!! 源 {code} 执行失败：{e}")

    # 类型白名单兜底（跨源统一）：只留 采购需求/采购公告/招标公告
    before = len(recs)
    recs = [r for r in recs if type_allowed(r.get("annType", ""))]
    if before != len(recs):
        log(f"类型白名单兜底：剔除中标/更正/合同等 {before - len(recs)} 条")

    # 去重：优先 projectCode（gdgpo 数据更全，优先保留），兜底 title+日期
    code_best = {}  # projectCode -> 最佳记录（gdgpo 优先）
    for r in recs:
        pc = r.get("projectCode") or ""
        if pc not in ("", "—"):
            old = code_best.get(pc)
            if old is None:
                code_best[pc] = r
            else:
                old_src_gdgpo = "gdgpo" in old.get("sourceUrl", "")
                new_src_gdgpo = "gdgpo" in r.get("sourceUrl", "")
                if new_src_gdgpo and not old_src_gdgpo:
                    code_best[pc] = r  # 新的是 gdgpo，替换
    # 剩下按标题+日期兜底（没 projectCode 的）
    uniq, seen = [], set()
    used_codes = set()
    for pc, r in code_best.items():
        uniq.append(r)
        used_codes.add(pc)
    for r in recs:
        pc = r.get("projectCode") or ""
        if pc in used_codes:
            continue
        k = (r["title"][:40], r["pubDate"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)
    uniq.sort(key=lambda r: r["pubDate"], reverse=True)
    log(f"合计去重后 {len(uniq)} 条（窗口 {args.days} 天，城市=潮州，关键词命中，类型={','.join(TYPE_WHITELIST)}）")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(json.dumps(uniq, ensure_ascii=False, indent=2))
        log(f"写入 {args.out}")
        return

    payload = json.dumps(uniq, ensure_ascii=False, indent=2)
    for p in [os.path.join(BASE, "announcements.json"),
              os.path.join(BASE, "demo", "data", "announcements.json")]:
        with open(p, "w", encoding="utf-8") as f:
            f.write(payload)
        log(f"写入 {p}")
    inject_single_file(uniq)


if __name__ == "__main__":
    main()
