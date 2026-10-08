"""从 Python 权威模型导出共享 JSON Schema"""
import json
from pathlib import Path

from pydantic.json_schema import models_json_schema

from agro_runtime.tasks import TaskManifest, TaskStart
from agro_runtime.workspace_models import DescriptionUpload, DraftCreate, DraftSave, ConfigurationApply, PlanCreate, TaskIntent, LifecycleIntent

from agro_runtime.models import (CapabilityDescriptor, ExecutionRequest,
                                 OperationSnapshot, PackageDescriptor,
                                 StampedPose, SystemConfig, TargetList, PickResult)


def main():
    models = [PackageDescriptor, CapabilityDescriptor, SystemConfig,
              StampedPose, ExecutionRequest, OperationSnapshot, TargetList, PickResult, TaskManifest, TaskStart, DescriptionUpload, DraftCreate, DraftSave, ConfigurationApply, PlanCreate, TaskIntent, LifecycleIntent]
    _, schema = models_json_schema([(model, 'validation') for model in models],
                                  title='Agricultural capability contracts')
    schema['$schema'] = 'https://json-schema.org/draft/2020-12/schema'
    path = Path(__file__).with_name('schema.json')
    path.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
