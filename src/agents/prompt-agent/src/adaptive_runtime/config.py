from __future__ import annotations

from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", populate_by_name=True)

    agent_name: str = Field(validation_alias="AGENT_NAME")
    agent_namespace: str = Field(default="adaptive", validation_alias="AGENT_NAMESPACE")
    agent_instructions: str = Field(validation_alias="AGENT_INSTRUCTIONS")
    openai_base_url: str = Field(validation_alias="OPENAI_BASE_URL")
    openai_model: str = Field(validation_alias="OPENAI_MODEL")
    cluster_mode: Literal["connected", "redButton"] = Field(
        default="connected",
        validation_alias="CLUSTER_MODE",
    )
    temperature: float = Field(default=0.7, validation_alias="TEMPERATURE")
    top_p: float = Field(default=1.0, validation_alias="TOP_P")
    agent_tools: str = Field(default="[]", validation_alias="AGENT_TOOLS")
    agent_skills: str = Field(default="[]", validation_alias="AGENT_SKILLS")

    @property
    def deployment_name(self) -> str:
        return f"{self.agent_namespace}/{self.agent_name}"

    @property
    def openai_v1_base_url(self) -> str:
        base_url = self.openai_base_url.rstrip("/")
        if base_url.endswith("/v1"):
            return base_url
        return f"{base_url}/v1"
