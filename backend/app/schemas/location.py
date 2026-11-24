from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from backend.app.schemas.not_null import IgnoresNullForRequiredColumns
from backend.app.services.location_service import normalize_location_name

# Upper bound keeps the value inside a 32-bit INTEGER column (PostgreSQL would
# otherwise fail the write with a 500); no real shelf holds more.
MAX_LOCATION_CAPACITY = 100_000


class LocationCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    identifier: str | None = Field(default=None, max_length=100)
    capacity: int = Field(default=0, ge=0, le=MAX_LOCATION_CAPACITY)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return normalize_location_name(v)


class LocationUpdate(IgnoresNullForRequiredColumns):
    __orm_table__ = "locations"
    name: str | None = Field(default=None, min_length=1, max_length=255)
    identifier: str | None = Field(default=None, max_length=100)
    capacity: int | None = Field(default=None, ge=0, le=MAX_LOCATION_CAPACITY)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return normalize_location_name(v)


class LocationResponse(BaseModel):
    id: int
    name: str
    identifier: str | None = None
    spool_count: int = 0
    capacity: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
