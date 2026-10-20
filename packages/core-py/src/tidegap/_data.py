# GENERATED — DO NOT EDIT.
#
# Produced by scripts/gen-data.mjs from packages/core-ts/src/data/*.json.
# Edit those JSON files and run 'pnpm gen:data' to regenerate. CI fails
# on drift ('pnpm gen:data:check').
# ruff: noqa
"""Generated data tables mirrored from the JSON SSOT in @tidegap/core."""

from __future__ import annotations

from typing import Any

#: Industry-average Power Usage Effectiveness for hyperscaler data centres.
DEFAULT_PUE: float = 1.15

#: Backwards-compatible flat estimate. Used when no model is provided.
LEGACY_KWH_PER_TASK: float = 0.0015

#: Typical token shape used when a caller names a model but no token counts.
TYPICAL_INPUT_TOKENS: int = 500
TYPICAL_OUTPUT_TOKENS: int = 500

#: Per-model coefficient table. Keys are canonical lowercase names.
COEFFICIENTS: dict[str, dict[str, Any]] = {
    "claude-fable-5-1": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": None, "source": "estimated", "status": None},
    "claude-fable-5": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": None, "source": "estimated", "status": None},
    "claude-opus-5-5": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": None, "source": "estimated", "status": None},
    "claude-opus-5": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": None, "source": "estimated", "status": None},
    "claude-opus-4-8": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": None, "source": "estimated", "status": None},
    "claude-opus-4": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": 400, "source": "estimated", "status": "deprecated"},
    "claude-opus-4-7": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": 400, "source": "estimated", "status": None},
    "claude-opus-4-6": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": 400, "source": "estimated", "status": None},
    "claude-opus-4-5": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": None, "source": "estimated", "status": None},
    "claude-opus-4-1": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": 400, "source": "estimated", "status": "retired"},
    "claude-opus-3": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": 400, "source": "estimated", "status": "retired"},
    "claude-sonnet-5": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": None, "source": "estimated", "status": None},
    "claude-sonnet-4": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": 70, "source": "estimated", "status": "deprecated"},
    "claude-sonnet-4-6": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": 70, "source": "estimated", "status": None},
    "claude-sonnet-4-5": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": 70, "source": "estimated", "status": None},
    "claude-sonnet-3-7": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": 70, "source": "estimated", "status": "retired"},
    "claude-sonnet-3-5": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": 70, "source": "estimated", "status": "retired"},
    "claude-sonnet-3": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": 70, "source": "estimated", "status": "retired"},
    "claude-haiku-4-5": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": 13, "source": "estimated", "status": None},
    "claude-haiku-3-5": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": 13, "source": "estimated", "status": "retired"},
    "claude-haiku-3": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": 13, "source": "estimated", "status": "retired"},
    "gpt-6-astra": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": None, "source": "estimated", "status": None},
    "gpt-6-sol": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": None, "source": "estimated", "status": None},
    "gpt-6-luna": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": None, "source": "estimated", "status": None},
    "gpt-5": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": None, "source": "estimated", "status": None},
    "gpt-5-mini": {"wh_per_input_token": 0.0006, "wh_per_output_token": 0.003, "params_b": None, "source": "estimated", "status": None},
    "gpt-5-nano": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": None, "source": "estimated", "status": None},
    "gpt-4o": {"wh_per_input_token": 0.002, "wh_per_output_token": 0.01, "params_b": 200, "source": "estimated", "status": None},
    "gpt-4o-mini": {"wh_per_input_token": 0.0006, "wh_per_output_token": 0.003, "params_b": 30, "source": "estimated", "status": None},
    "gpt-4-1": {"wh_per_input_token": 0.002, "wh_per_output_token": 0.01, "params_b": None, "source": "estimated", "status": None},
    "gpt-4-1-mini": {"wh_per_input_token": 0.0006, "wh_per_output_token": 0.003, "params_b": None, "source": "estimated", "status": None},
    "gpt-4-1-nano": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": None, "source": "estimated", "status": None},
    "gpt-4-turbo": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": 400, "source": "estimated", "status": "deprecated"},
    "gpt-4": {"wh_per_input_token": 0.005, "wh_per_output_token": 0.025, "params_b": 1000, "source": "estimated", "status": "deprecated"},
    "gpt-3-5-turbo": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": 20, "source": "estimated", "status": None},
    "o1": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": 400, "source": "estimated", "status": None},
    "o1-mini": {"wh_per_input_token": 0.0006, "wh_per_output_token": 0.003, "params_b": 30, "source": "estimated", "status": "retired"},
    "o3": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": 400, "source": "estimated", "status": None},
    "o3-mini": {"wh_per_input_token": 0.0006, "wh_per_output_token": 0.003, "params_b": 30, "source": "estimated", "status": "deprecated"},
    "gemini-3-1-pro": {"wh_per_input_token": 0.002, "wh_per_output_token": 0.01, "params_b": None, "source": "estimated", "status": None},
    "gemini-3-8-flash": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": None, "source": "estimated", "status": None},
    "gemini-3-5-flash-lite": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": None, "source": "estimated", "status": None},
    "gemini-1-5-pro": {"wh_per_input_token": 0.002, "wh_per_output_token": 0.01, "params_b": 200, "source": "estimated", "status": "retired"},
    "gemini-1-5-flash": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": 20, "source": "estimated", "status": "retired"},
    "gemini-2-0-flash": {"wh_per_input_token": 0.0003, "wh_per_output_token": 0.0015, "params_b": 20, "source": "estimated", "status": "retired"},
    "gemini-2-0-pro": {"wh_per_input_token": 0.002, "wh_per_output_token": 0.01, "params_b": 200, "source": "estimated", "status": "retired"},
    "llama-3-1-405b": {"wh_per_input_token": 0.005, "wh_per_output_token": 0.025, "params_b": 405, "source": "measured", "status": None},
    "llama-3-1-70b": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": 70, "source": "measured", "status": None},
    "llama-3-1-8b": {"wh_per_input_token": 0.0002, "wh_per_output_token": 0.001, "params_b": 8, "source": "measured", "status": None},
    "llama-3-70b": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": 70, "source": "measured", "status": None},
    "llama-3-8b": {"wh_per_input_token": 0.0002, "wh_per_output_token": 0.001, "params_b": 8, "source": "measured", "status": None},
    "llama-4-scout": {"wh_per_input_token": 0.0006, "wh_per_output_token": 0.003, "params_b": None, "source": "estimated", "status": None},
    "llama-4-maverick": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": None, "source": "estimated", "status": None},
    "mistral-small-4": {"wh_per_input_token": 0.0006, "wh_per_output_token": 0.003, "params_b": None, "source": "estimated", "status": None},
    "mistral-medium-3-5": {"wh_per_input_token": 0.001, "wh_per_output_token": 0.005, "params_b": None, "source": "estimated", "status": None},
    "mistral-large-3": {"wh_per_input_token": 0.003, "wh_per_output_token": 0.015, "params_b": None, "source": "estimated", "status": None},
    "mistral-7b": {"wh_per_input_token": 0.0002, "wh_per_output_token": 0.001, "params_b": 7, "source": "measured", "status": None},
    "mixtral-8x7b": {"wh_per_input_token": 0.0006, "wh_per_output_token": 0.003, "params_b": 47, "source": "measured", "status": None},
    "mixtral-8x22b": {"wh_per_input_token": 0.0015, "wh_per_output_token": 0.0075, "params_b": 141, "source": "measured", "status": None},
}

#: Ordered family-fallback rules (see _family_representative).
FAMILIES: list[dict[str, Any]] = [
    {"id": "claude-fable", "representative": "claude-fable-5-1", "contains": ["fable"], "prefix": None, "regex": None},
    {"id": "claude-mythos", "representative": "claude-fable-5-1", "contains": ["mythos"], "prefix": None, "regex": None},
    {"id": "claude-opus", "representative": "claude-opus-5", "contains": ["opus"], "prefix": None, "regex": None},
    {"id": "claude-sonnet", "representative": "claude-sonnet-5", "contains": ["sonnet"], "prefix": None, "regex": None},
    {"id": "claude-haiku", "representative": "claude-haiku-4-5", "contains": ["haiku"], "prefix": None, "regex": None},
    {"id": "gpt-6", "representative": "gpt-6-sol", "contains": None, "prefix": "gpt-6", "regex": None},
    {"id": "gpt-5", "representative": "gpt-5", "contains": None, "prefix": "gpt-5", "regex": None},
    {"id": "gpt-4o", "representative": "gpt-4o", "contains": None, "prefix": "gpt-4o", "regex": None},
    {"id": "gpt-4-1", "representative": "gpt-4-1", "contains": None, "prefix": "gpt-4-1", "regex": None},
    {"id": "gpt-4", "representative": "gpt-4", "contains": None, "prefix": "gpt-4", "regex": None},
    {"id": "gpt-3", "representative": "gpt-3-5-turbo", "contains": None, "prefix": "gpt-3", "regex": None},
    {"id": "openai-o", "representative": "o3", "contains": None, "prefix": None, "regex": "^o[0-9]"},
    {"id": "gemini-flash", "representative": "gemini-3-8-flash", "contains": ["flash"], "prefix": "gemini", "regex": None},
    {"id": "gemini-pro", "representative": "gemini-3-1-pro", "contains": None, "prefix": "gemini", "regex": None},
    {"id": "mixtral", "representative": "mixtral-8x7b", "contains": None, "prefix": "mixtral", "regex": None},
    {"id": "mistral", "representative": "mistral-7b", "contains": None, "prefix": "mistral", "regex": None},
    {"id": "llama", "representative": "llama-3-1-70b", "contains": None, "prefix": "llama", "regex": None},
]

#: Citation metadata for the coefficient table.
ENERGY_SOURCES: dict[str, dict[str, str]] = {
    "patterson2021": {"citation": "Patterson et al. 2021, 'Carbon Emissions and Large Neural Network Training'", "arxiv": "2104.10350"},
    "luccioni2024": {"citation": "Luccioni, Jernite, Strubell 2024, 'Power Hungry Processing'", "venue": "FAccT 2024", "arxiv": "2311.16863"},
    "huggingface": {"citation": "Hugging Face AI Energy Score", "url": "https://huggingface.co/AIEnergyScore"},
}

#: Synthetic-curve region midpoints (gCO2/kWh).
REGION_FLOORS: dict[str, int] = {
    "US-CAL-CISO": 280,
    "US-TEX-ERCO": 340,
    "US-NE-ISNE": 320,
    "US-MIDA-PJM": 420,
    "GB": 220,
    "FR": 60,
    "DE": 380,
    "IE": 340,
    "NL": 350,
    "ES": 160,
    "BE": 140,
    "AT": 110,
    "PL": 650,
    "JP-TK": 470,
    "KR": 430,
    "SG": 420,
    "AU-NSW": 500,
    "CA-ON": 50,
    "US-NY-NYIS": 360,
    "US-MIDW-MISO": 460,
    "US-NW-BPAT": 110,
    "US-FLA-FPL": 400,
    "IT-NO": 320,
    "SE-SE3": 40,
    "NO-NO1": 30,
    "FI": 120,
    "DK-DK1": 180,
    "IN-WE": 700,
    "ZA": 700,
    "AE": 620,
    "NZ": 80,
}

#: Fallback midpoint for regions with no explicit floor.
DEFAULT_REGION_FLOOR: int = 380

#: Peak-to-trough half-swing of the synthetic curve (gCO2/kWh).
SYNTHETIC_AMPLITUDE: int = 220

#: Per-region UTC-hour offset applied to the synthetic curve's local trough.
REGION_UTC_OFFSETS: dict[str, int] = {
    "US-CAL-CISO": -8,
    "US-TEX-ERCO": -6,
    "US-NE-ISNE": -5,
    "US-MIDA-PJM": -5,
    "GB": 0,
    "FR": 1,
    "DE": 1,
    "IE": 0,
    "NL": 1,
    "ES": 1,
    "BE": 1,
    "AT": 1,
    "PL": 1,
    "JP-TK": 9,
    "KR": 9,
    "SG": 8,
    "AU-NSW": 10,
    "CA-ON": -5,
    "US-NY-NYIS": -5,
    "US-MIDW-MISO": -6,
    "US-NW-BPAT": -8,
    "US-FLA-FPL": -5,
    "IT-NO": 1,
    "SE-SE3": 1,
    "NO-NO1": 1,
    "FI": 2,
    "DK-DK1": 1,
    "IN-WE": 5,
    "ZA": 2,
    "AE": 4,
    "NZ": 12,
}

#: Supported grid zones for people: name, ISO country code, country name and
#: grid operator. Keys equal REGION_FLOORS and the website's zone list.
REGION_CATALOG: dict[str, dict[str, str]] = {
    "US-CAL-CISO": {"name": "California", "country": "US", "country_name": "United States", "operator": "California ISO (CAISO)"},
    "US-TEX-ERCO": {"name": "Texas", "country": "US", "country_name": "United States", "operator": "ERCOT"},
    "US-NE-ISNE": {"name": "New England", "country": "US", "country_name": "United States", "operator": "ISO New England"},
    "US-MIDA-PJM": {"name": "PJM Mid-Atlantic", "country": "US", "country_name": "United States", "operator": "PJM Interconnection"},
    "GB": {"name": "Great Britain", "country": "GB", "country_name": "United Kingdom", "operator": "National Energy System Operator (NESO)"},
    "FR": {"name": "France", "country": "FR", "country_name": "France", "operator": "RTE"},
    "DE": {"name": "Germany", "country": "DE", "country_name": "Germany", "operator": "50Hertz, Amprion, TenneT, TransnetBW"},
    "IE": {"name": "Ireland", "country": "IE", "country_name": "Ireland", "operator": "EirGrid"},
    "NL": {"name": "Netherlands", "country": "NL", "country_name": "Netherlands", "operator": "TenneT"},
    "ES": {"name": "Spain", "country": "ES", "country_name": "Spain", "operator": "Red Eléctrica (REE)"},
    "BE": {"name": "Belgium", "country": "BE", "country_name": "Belgium", "operator": "Elia"},
    "AT": {"name": "Austria", "country": "AT", "country_name": "Austria", "operator": "Austrian Power Grid (APG)"},
    "PL": {"name": "Poland", "country": "PL", "country_name": "Poland", "operator": "PSE"},
    "JP-TK": {"name": "Tokyo", "country": "JP", "country_name": "Japan", "operator": "TEPCO Power Grid"},
    "KR": {"name": "South Korea", "country": "KR", "country_name": "South Korea", "operator": "Korea Power Exchange (KPX)"},
    "SG": {"name": "Singapore", "country": "SG", "country_name": "Singapore", "operator": "Energy Market Authority (EMA)"},
    "AU-NSW": {"name": "New South Wales", "country": "AU", "country_name": "Australia", "operator": "AEMO"},
    "CA-ON": {"name": "Ontario", "country": "CA", "country_name": "Canada", "operator": "IESO"},
    "US-NY-NYIS": {"name": "New York", "country": "US", "country_name": "United States", "operator": "NYISO"},
    "US-MIDW-MISO": {"name": "Midcontinent", "country": "US", "country_name": "United States", "operator": "MISO"},
    "US-NW-BPAT": {"name": "Pacific Northwest", "country": "US", "country_name": "United States", "operator": "Bonneville Power Administration (BPA)"},
    "US-FLA-FPL": {"name": "Florida", "country": "US", "country_name": "United States", "operator": "Florida Power & Light (FPL)"},
    "IT-NO": {"name": "Northern Italy", "country": "IT", "country_name": "Italy", "operator": "Terna"},
    "SE-SE3": {"name": "Central Sweden (SE3)", "country": "SE", "country_name": "Sweden", "operator": "Svenska kraftnät"},
    "NO-NO1": {"name": "Southeast Norway (NO1)", "country": "NO", "country_name": "Norway", "operator": "Statnett"},
    "FI": {"name": "Finland", "country": "FI", "country_name": "Finland", "operator": "Fingrid"},
    "DK-DK1": {"name": "West Denmark (DK1)", "country": "DK", "country_name": "Denmark", "operator": "Energinet"},
    "IN-WE": {"name": "Western India", "country": "IN", "country_name": "India", "operator": "Grid Controller of India"},
    "ZA": {"name": "South Africa", "country": "ZA", "country_name": "South Africa", "operator": "Eskom"},
    "AE": {"name": "United Arab Emirates", "country": "AE", "country_name": "United Arab Emirates", "operator": "EWEC and DEWA"},
    "NZ": {"name": "New Zealand", "country": "NZ", "country_name": "New Zealand", "operator": "Transpower"},
}

#: Band thresholds (ascending). A value maps to the first band it is below.
BAND_THRESHOLDS: list[tuple[int, str]] = [
    (100, "very_clean"),
    (250, "clean"),
    (450, "average"),
    (700, "dirty"),
]

#: Band for values at or above every threshold.
DEFAULT_BAND: str = "very_dirty"

#: Month the price table figures were read (see prices.json).
PRICES_AS_OF: str = "2026-09"

#: Per-model public list prices (USD per million tokens), keyed by the same
#: canonical lowercase ids as COEFFICIENTS. Ollama-routable open-weight models
#: are 0 (self-hosted). Used by cross-provider routing's cost dimension.
MODEL_PRICES: dict[str, dict[str, Any]] = {
    "claude-fable-5-1": {"in_usd_per_mtok": 10, "out_usd_per_mtok": 50, "batch_discount": 0.5, "as_of": "2026-09", "source": "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)"},
    "claude-fable-5": {"in_usd_per_mtok": 10, "out_usd_per_mtok": 50, "batch_discount": 0.5, "as_of": "2026-09", "source": "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)"},
    "claude-opus-5-5": {"in_usd_per_mtok": 4, "out_usd_per_mtok": 20, "batch_discount": 0.5, "as_of": "2026-09", "source": "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)"},
    "claude-opus-5": {"in_usd_per_mtok": 5, "out_usd_per_mtok": 25, "batch_discount": 0.5, "as_of": "2026-09", "source": "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)"},
    "claude-opus-4-8": {"in_usd_per_mtok": 5, "out_usd_per_mtok": 25, "batch_discount": 0.5, "as_of": "2026-09", "source": "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)"},
    "claude-opus-4": {"in_usd_per_mtok": 15, "out_usd_per_mtok": 75, "batch_discount": 0.5, "as_of": "2026-07", "source": "Anthropic pricing (anthropic.com/pricing)"},
    "claude-opus-4-7": {"in_usd_per_mtok": 5, "out_usd_per_mtok": 25, "batch_discount": 0.5, "as_of": "2026-09", "source": "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)"},
    "claude-opus-4-6": {"in_usd_per_mtok": 5, "out_usd_per_mtok": 25, "batch_discount": 0.5, "as_of": "2026-09", "source": "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)"},
    "claude-sonnet-5": {"in_usd_per_mtok": 2, "out_usd_per_mtok": 10, "batch_discount": 0.5, "as_of": "2026-09", "source": "Anthropic pricing (platform.claude.com/docs/en/about-claude/pricing)"},
    "claude-sonnet-4": {"in_usd_per_mtok": 3, "out_usd_per_mtok": 15, "batch_discount": 0.5, "as_of": "2026-07", "source": "Anthropic pricing (anthropic.com/pricing)"},
    "claude-sonnet-4-6": {"in_usd_per_mtok": 3, "out_usd_per_mtok": 15, "batch_discount": 0.5, "as_of": "2026-07", "source": "Anthropic pricing (anthropic.com/pricing)"},
    "claude-sonnet-4-5": {"in_usd_per_mtok": 3, "out_usd_per_mtok": 15, "batch_discount": 0.5, "as_of": "2026-07", "source": "Anthropic pricing (anthropic.com/pricing)"},
    "claude-haiku-4-5": {"in_usd_per_mtok": 1, "out_usd_per_mtok": 5, "batch_discount": 0.5, "as_of": "2026-07", "source": "Anthropic pricing (anthropic.com/pricing)"},
    "gpt-6-astra": {"in_usd_per_mtok": 10, "out_usd_per_mtok": 50, "batch_discount": 0.5, "as_of": "2026-09", "source": "OpenAI API pricing (developers.openai.com/api/docs/pricing)"},
    "gpt-6-sol": {"in_usd_per_mtok": 2, "out_usd_per_mtok": 10, "batch_discount": 0.5, "as_of": "2026-09", "source": "OpenAI API pricing (developers.openai.com/api/docs/pricing)"},
    "gpt-6-luna": {"in_usd_per_mtok": 0.1, "out_usd_per_mtok": 0.5, "batch_discount": 0.5, "as_of": "2026-09", "source": "OpenAI API pricing (developers.openai.com/api/docs/pricing)"},
    "gpt-4o": {"in_usd_per_mtok": 2.5, "out_usd_per_mtok": 10, "batch_discount": 0.5, "as_of": "2026-07", "source": "OpenAI API pricing (openai.com/api/pricing)"},
    "gpt-4o-mini": {"in_usd_per_mtok": 0.15, "out_usd_per_mtok": 0.6, "batch_discount": 0.5, "as_of": "2026-07", "source": "OpenAI API pricing (openai.com/api/pricing)"},
    "gpt-4-turbo": {"in_usd_per_mtok": 10, "out_usd_per_mtok": 30, "batch_discount": 0.5, "as_of": "2026-07", "source": "OpenAI API pricing (openai.com/api/pricing)"},
    "gpt-4": {"in_usd_per_mtok": 30, "out_usd_per_mtok": 60, "batch_discount": 0.5, "as_of": "2026-07", "source": "OpenAI API pricing (openai.com/api/pricing)"},
    "gpt-3-5-turbo": {"in_usd_per_mtok": 0.5, "out_usd_per_mtok": 1.5, "batch_discount": 0.5, "as_of": "2026-07", "source": "OpenAI API pricing (openai.com/api/pricing)"},
    "o1": {"in_usd_per_mtok": 15, "out_usd_per_mtok": 60, "batch_discount": 0.5, "as_of": "2026-07", "source": "OpenAI API pricing (openai.com/api/pricing)"},
    "o3": {"in_usd_per_mtok": 2, "out_usd_per_mtok": 8, "batch_discount": 0.5, "as_of": "2026-07", "source": "OpenAI API pricing (openai.com/api/pricing)"},
    "o3-mini": {"in_usd_per_mtok": 1.1, "out_usd_per_mtok": 4.4, "batch_discount": 0.5, "as_of": "2026-07", "source": "OpenAI API pricing (openai.com/api/pricing)"},
    "llama-3-1-405b": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-07", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "llama-3-1-70b": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-07", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "llama-3-1-8b": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-07", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "llama-3-70b": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-07", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "llama-3-8b": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-07", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "llama-4-scout": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-09", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "llama-4-maverick": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-09", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "mistral-small-4": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-09", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "mistral-medium-3-5": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-09", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "mistral-large-3": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-09", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "mistral-7b": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-07", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "mixtral-8x7b": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-07", "source": "Ollama local (self-hosted; no per-token vendor price)"},
    "mixtral-8x22b": {"in_usd_per_mtok": 0, "out_usd_per_mtok": 0, "batch_discount": None, "as_of": "2026-07", "source": "Ollama local (self-hosted; no per-token vendor price)"},
}
