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
    assert rec["district"] == "湘桥"
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
