import pytest
from pydantic import ValidationError
from alphaview.panel.backups import NumericFilters


@pytest.mark.parametrize('value', ['0x10', '0b10', '0o10', '+1', ' 1', '1 ', '1.', '1.e2', '1_000', '１２', '1e', '1e+'])
def test_backup_rejects_invisible_number_input_forms(value):
    with pytest.raises(ValidationError):
        NumericFilters(priceMin=value)


@pytest.mark.parametrize('value', ['0', '-0', '01', '0.5', '.5', '1e2', '1E+2', '1e-2', '0' * 29 + '1'])
def test_backup_preserves_valid_numeric_strings(value):
    assert NumericFilters(priceMin=value).priceMin == value
