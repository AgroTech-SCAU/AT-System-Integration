"""GUI 与 CLI 共用管理请求契约"""
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr
from .models import Identifier, JsonValue

class WorkspaceRequest(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)

class DescriptionUpload(WorkspaceRequest):
    filename: StrictStr=Field(min_length=1,max_length=255)
    content: StrictStr=Field(max_length=2097152)

class DraftCreate(WorkspaceRequest):
    base_snapshot_id: StrictStr=Field(pattern=r'^[0-9a-f]{64}$')
    content: dict[StrictStr,JsonValue] | None=None

class DraftSave(WorkspaceRequest):
    revision: StrictInt=Field(ge=1)
    content: dict[StrictStr,JsonValue]

class ConfigurationApply(WorkspaceRequest):
    draft_id: Identifier
    revision: StrictInt=Field(ge=1)
    base_snapshot_id: StrictStr=Field(pattern=r'^[0-9a-f]{64}$')
    request_id: Identifier

class PlanCreate(WorkspaceRequest):
    template_id: Identifier='tomato_picker'
    parameters: dict[Identifier,JsonValue]=Field(default_factory=dict)
    asset_id: Identifier | None=None

class TaskIntent(WorkspaceRequest):
    request_id: Identifier

class LifecycleIntent(WorkspaceRequest):
    request_id: Identifier | None=None
    path: StrictStr | None=None
