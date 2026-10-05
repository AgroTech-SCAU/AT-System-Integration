"""契约边界统一错误"""
from pydantic import BaseModel, ValidationError


class ValidationIssue(BaseModel):
    path: str
    code: str
    reason: str


class ContractValidationError(ValueError):
    def __init__(self, issues: list[ValidationIssue]):
        self.issues = issues
        super().__init__('; '.join(f'{i.path}: {i.code}: {i.reason}' for i in issues))


def field_path(loc, prefix='$'):
    return prefix + ''.join(f'[{part}]' if isinstance(part, int) else f'.{part}' for part in loc)


def fail(path, code, reason):
    raise ContractValidationError([ValidationIssue(path=path, code=code, reason=reason)])


def parse(model, data, prefix='$'):
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        codes = {'extra_forbidden': 'unknown_field', 'missing': 'required_field',
                 'string_pattern_mismatch': 'invalid_identifier'}
        issues = []
        for error in exc.errors(include_url=False):
            code = codes.get(error['type'], error['type'])
            if code.endswith(('_type', '_parsing')) or code in {'model_type', 'enum', 'literal_error'}:
                code = 'invalid_type'
            issues.append(ValidationIssue(path=field_path(error['loc'], prefix),
                                          code=code, reason=error['msg']))
        raise ContractValidationError(issues) from exc
