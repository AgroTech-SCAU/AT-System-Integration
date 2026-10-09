"""行为树编辑文档，XML 仍为唯一执行定义"""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr
from .models import Identifier, JsonValue, TypeDescriptor, ParameterDescriptor

class TreeModel(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)

class PortBinding(TreeModel):
    kind: Literal['typed_literal','blackboard_reference']
    value: JsonValue = None
    key: Identifier | None = None
    type: dict[StrictStr,JsonValue] = Field(default_factory=dict)

class TreeNode(TreeModel):
    editor_id: Identifier
    registration_id: StrictStr
    children: list[Identifier] = Field(default_factory=list)
    ports: dict[StrictStr,PortBinding] = Field(default_factory=dict)
    attributes: dict[StrictStr,StrictStr] = Field(default_factory=dict)

class SubtreePort(TreeModel):
    direction: Literal['INPUT','OUTPUT']
    type: TypeDescriptor

class TreeDefinition(TreeModel):
    tree_id: StrictStr = Field(pattern=r'^[A-Za-z][A-Za-z0-9_]{0,63}$')
    root_id: Identifier
    nodes: dict[Identifier,TreeNode]
    ports: dict[Identifier,SubtreePort] = Field(default_factory=dict)

class TreeDocument(TreeModel):
    main_tree_id: StrictStr
    trees: dict[StrictStr,TreeDefinition]
    revision: StrictInt = Field(ge=1,default=1)
    inputs: dict[Identifier,ParameterDescriptor] = Field(default_factory=dict)
    model_digest: StrictStr
    readonly: bool = False
    original_xml: StrictStr | None = None
    unsupported: list[StrictStr] = Field(default_factory=list)

class LayoutDocument(TreeModel):
    revision: StrictInt = Field(ge=1,default=1)
    positions: dict[Identifier,tuple[float,float]] = Field(default_factory=dict)
    labels: dict[Identifier,StrictStr] = Field(default_factory=dict)
    collapsed: list[Identifier] = Field(default_factory=list)
    zoom: float = Field(ge=.2,le=3,default=1)

class Diagnostic(TreeModel):
    severity: Literal['error','warning'] = 'error'
    code: StrictStr
    tree_id: StrictStr | None = None
    editor_id: Identifier | None = None
    port: StrictStr | None = None
    reason: StrictStr

class TreeCreate(TreeModel):
    xml: StrictStr | None = Field(default=None,max_length=1048576)
    template: Literal['general','tomato_picker','simulation_inspection']='general'

class TreeSave(TreeModel):
    revision: StrictInt
    layout_revision: StrictInt
    document: TreeDocument
    layout: LayoutDocument
    parameters: dict[Identifier,JsonValue] = Field(default_factory=dict)

class TreePublish(TreeModel):
    revision: StrictInt
    base_snapshot_id: StrictStr

class TreeExtract(TreeModel):
    document: TreeDocument
    tree_id: StrictStr
    editor_id: Identifier
    subtree_id: StrictStr = Field(pattern=r'^[A-Za-z][A-Za-z0-9_]{0,63}$')
    ports: dict[Identifier,SubtreePort] | None = None

class TreeValidate(TreeModel):
    document: TreeDocument
    policy: Literal['general','simulation_inspection','tomato_picker']='general'
    parameters: dict[Identifier,JsonValue] = Field(default_factory=dict)
