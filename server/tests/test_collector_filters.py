"""采集器城市过滤 / 噪声过滤 / 稳定 ID 测试（直接加载 collector/collect.py）。"""
from __future__ import annotations

import importlib.util
from pathlib import Path

COLLECT = Path(__file__).resolve().parents[2] / "collector" / "collect.py"
spec = importlib.util.spec_from_file_location("bx_collect", COLLECT)
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)

BASE = dict(
    source_url="https://example.com/notice",
    pub_date="2026-10-22",
    buyer="",
    agency="",
    budget="",
    contact="",
    contacts={},
    ann_type="招标公告",
    extra_text="潮州市 汕头市 深圳市 广州市（导航里的城市列表）",
)


def test_shenzhen_notice_with_nav_chaozhou_is_rejected():
    rec = collect.build_record(
        title="招标公告",
        summary="深圳能源环保股份有限公司下属发电厂2027年度飞灰螯合物吨袋采购项目 项目名称：深圳能源环保股份有限公司下属发电厂2027年度飞灰螯合物吨袋采购项目",
        source_name="深圳能源采购平台",
        **BASE,
    )
    assert rec is None


def test_chaozhou_notice_is_kept():
    rec = collect.build_record(
        title="潮州市湘桥区智慧平台项目招标公告",
        summary="项目名称：潮州市湘桥区智慧平台项目 本项目位于潮州市湘桥区，建设信息化平台，欢迎投标。",
        source_name="某站点",
        **BASE,
    )
    assert rec is not None
    assert rec["region"] == "潮州"
    assert rec["district"] == "市区"
    assert rec["id"].startswith("ANN20261022")


def test_homepage_navigation_is_rejected():
    rec = collect.build_record(
        title="广东省农村产权流转交易管理服务平台",
        summary="您好 登录/注册 用户中心 退出 广东省农村产权流转交易管理服务平台 首页 资讯中心 交易大厅 资产所在地 潮州市",
        source_name="广东省农村产权流转交易管理服务平台",
        **BASE,
    )
    assert rec is None


def test_stable_id_same_input():
    rec1 = collect.build_record(
        title="潮州市测试项目智慧平台采购公告",
        summary="项目名称：潮州市测试项目智慧平台 潮州市 平台",
        source_name="站点",
        **BASE,
    )
    rec2 = collect.build_record(
        title="潮州市测试项目智慧平台采购公告",
        summary="项目名称：潮州市测试项目智慧平台 潮州市 平台",
        source_name="站点",
        **BASE,
    )
    assert rec1["id"] == rec2["id"]


# =============================================================================
# 2026-11-04 热修复：列表页假公告 / 联合采购误收 / 未来日期
# 背景：线上跑出「诚E招电子采购交易平台」这类列表页假公告，
# 且全国性平台的联合采购因正文提到潮州区县被误收为潮州商机。
# =============================================================================


def test_site_alias_title_is_rejected():
    """页面 <title> 与配置名不一致时，别名标题（平台名）要被丢弃。"""
    rec = collect.build_record(
        title="诚E招电子采购交易平台",
        summary="意溪镇农村小型集中式供水工程维修养护项目 潮州市湘桥区 智慧平台 采购",
        source_name="公诚管理咨询有限公司",
        site_names=["公诚管理咨询有限公司", "诚E招电子采购交易平台"],
        **BASE,
    )
    assert rec is None


def test_national_platform_mentioning_chaozhou_town_is_rejected():
    """主体在外地、仅正文包件清单提到潮州区县的联合采购要剔除。"""
    rec = collect.build_record(
        title="深圳能源环保股份有限公司下属发电厂2027年度飞灰螯合物吨袋采购项目",
        summary=(
            "项目名称：深圳能源环保股份有限公司下属发电厂2027年度飞灰螯合物吨袋采购项目 "
            "6）潮安厂 地点：广东省潮州市潮安区沙溪镇 7）湘桥厂 地点：广东省潮州市湘桥区铁铺镇 "
            "智慧平台 采购"
        ),
        source_name="深圳能源电子招标投标平台",
        **{**BASE, "buyer": "深圳能源环保股份有限公司"},
    )
    assert rec is None


def test_chaozhou_town_only_title_is_kept():
    """标题只写镇名（采购人解析为空）时，靠潮州下辖镇名判定归属，不误杀。"""
    rec = collect.build_record(
        title="意溪镇农村小型集中式供水工程维修养护项目（超滤膜一体化设备采购）市场价格调研公告",
        summary="我司受潮州市湘桥区意溪镇人民政府委托，现进行该项目建设智慧平台采购。",
        source_name="公诚管理咨询有限公司",
        **BASE,
    )
    assert rec is not None


def test_jnu_chaoshan_hospital_is_kept():
    """暨南大学潮汕医院（饶平）名称里无区县字样，不能误杀本地商机。"""
    rec = collect.build_record(
        title="暨南大学附属第一医院潮汕医院医疗设备维保服务采购项目招标公告",
        summary="项目名称：暨南大学附属第一医院潮汕医院医疗设备维保服务采购项目 智慧平台采购",
        source_name="某站点",
        **{**BASE, "buyer": "暨南大学附属第一医院潮汕医院",
           "extra_text": "潮州市饶平县"},
    )
    assert rec is not None


def test_is_list_page_url():
    assert collect.is_list_page_url(
        "https://www.chengezhao.com/cms/categories/%E4%B8%9A%E5%8A%A1%E5%85%AC%E5%91%8A/"
    )
    assert collect.is_list_page_url("https://www.gxxszb.com/list")
    assert not collect.is_list_page_url("https://www.chengezhao.com/cms/post/1/4/1492221/")
    assert not collect.is_list_page_url("https://zb.sec.com.cn/zbgg/21461.jhtml")
    assert not collect.is_list_page_url("https://www.czggzy.com:8088/info.u.jsp?id=2023&clsid=J")


def test_parse_date_skips_future_date():
    """列表页第一个日期可能是「投标截止时间」（未来），应取更早的发布日期。"""
    html = "<div>原投标截止时间为2026年11月12日09时30分 发布日期2026-10-22</div>"
    assert collect._parse_date(html) == "2026-10-22"


def test_parse_date_keeps_past_date():
    assert collect._parse_date("<div>发布时间：2026-11-04</div>") == "2026-11-04"


def test_short_non_announcement_title_is_rejected():
    """标题被平台名污染后既短又无公告后缀，要丢弃。"""
    rec = collect.build_record(
        title="电子卖场",
        summary="潮州市湘桥区 智慧平台 采购公告",
        source_name="深圳公共资源交易中心",
        **BASE,
    )
    assert rec is None
