<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 16

Inventory & Asset Management
Inventory and Asset Management should be related but distinct concepts:
Inventory
→ Consumable / quantity-based stock

Assets
→ Individually identifiable long-lived items
For example:
Inventory:
Paper, pens, cleaning supplies

Assets:
Laptop, projector, desk, bus, laboratory equipment
This distinction avoids forcing serial-number tracking onto consumable stock.

657. Domain Boundary
Inventory & Asset Management owns:
item catalogue
inventory categories
stores/warehouses
stock levels
stock receipts
stock issues
stock transfers
stock adjustments
stock counts
suppliers/reference data
assets
asset assignments
asset maintenance
asset disposal
asset status/history
It does not own:
purchase accounting
fee transactions
teacher/student identity
payroll
transport vehicles
library books
Other domains can reference assets where appropriate.

658. Item Classification
Use:
Item
 ├── INVENTORY_ITEM
 └── ASSET
An inventory item is quantity-based.
An asset is individually identifiable.

659. Item Catalogue
items
-----
id
tenant_id
code
name
description
item_type
category_id
unit_of_measure
track_quantity
track_serial_number
track_batch
status
created_at
updated_at
version
Item types:
INVENTORY
ASSET

660. Item Categories
item_categories
---------------
id
tenant_id
parent_category_id
code
name
description
status
created_at
updated_at
Examples:
Stationery
Laboratory
IT Equipment
Furniture
Cleaning
Sports
Electrical

661. Units of Measure
Examples:
PCS
BOX
PACK
KG
LITRE
METER
SET
V1 should use a configurable list rather than a complex unit-conversion engine.

662. Store / Warehouse
inventory_stores
----------------
id
tenant_id
code
name
location
store_type
status
created_at
updated_at
version
Store types:
MAIN_STORE
LAB_STORE
LIBRARY_STORE
SPORTS_STORE
OTHER

663. Stock Balance
Stock balance is a derived quantity.
stock_balances
--------------
id
tenant_id
item_id
store_id
quantity_on_hand
quantity_reserved
quantity_available
updated_at
version
Conceptually:
Available
=
On Hand
-
Reserved
The authoritative history is the stock movement ledger.

664. Stock Movement
stock_movements
---------------
id
tenant_id
item_id
store_id
movement_type
quantity
unit_cost
reference_type
reference_id
reason
created_by
created_at
Movement types:
RECEIPT
ISSUE
TRANSFER_OUT
TRANSFER_IN
ADJUSTMENT_IN
ADJUSTMENT_OUT
RETURN
WRITE_OFF

665. Stock Ledger Principle
Never directly edit:
quantity_on_hand
as the primary business operation.
Instead:
Stock Movement
 ↓
Ledger
 ↓
Balance Projection
This preserves an auditable history.

666. Stock Receipt
A receipt brings inventory into a store.
stock_receipts
--------------
id
tenant_id
store_id
reference_number
received_date
supplier_id
status
created_by
created_at
updated_at
Status:
DRAFT
RECEIVED
CANCELLED

667. Stock Receipt Lines
stock_receipt_lines
-------------------
id
tenant_id
receipt_id
item_id
quantity
unit_cost
batch_number
expiry_date
serial_numbers
created_at
The receipt records what physically entered the store.

668. Supplier Reference
V1 can have a lightweight supplier model:
inventory_suppliers
-------------------
id
tenant_id
code
name
contact_name
phone
email
address
status
created_at
updated_at
A full Procurement domain can later own supplier contracts/purchase orders.

669. Purchase Order Separation
Do not force a full procurement system into Inventory V1.
Future architecture:
Procurement
    ↓
Purchase Order
    ↓
Inventory
    ↓
Goods Receipt
Inventory only needs the reference to the upstream procurement document.

670. Stock Issue
Issue stock from a store to a destination.
stock_issues
-----------
id
tenant_id
store_id
reference_number
issued_to_type
issued_to_id
issue_date
status
created_by
created_at
updated_at
Destinations might include:
DEPARTMENT
CLASSROOM
TEACHER
EVENT
LABORATORY
OTHER

671. Stock Issue Lines
stock_issue_lines
-----------------
id
tenant_id
issue_id
item_id
quantity
unit_cost_snapshot
created_at
Issuing stock creates:
ISSUE
stock movements.

672. Stock Return
Unused consumables can be returned.
stock_returns
-------------
id
tenant_id
store_id
reference_number
returned_from_type
returned_from_id
return_date
status
created_by
created_at
A return creates:
RETURN
movement.

673. Stock Transfer
Transfers between stores must be represented as one logical operation.
stock_transfers
---------------
id
tenant_id
from_store_id
to_store_id
reference_number
status
requested_at
completed_at
created_by
Status:
DRAFT
REQUESTED
IN_TRANSIT
RECEIVED
CANCELLED

674. Transfer Integrity
A completed transfer produces:
Store A
TRANSFER_OUT

Store B
TRANSFER_IN
These should share a common transfer reference.
Do not model the transfer as an unexplained adjustment.

675. Stock Adjustment
Manual correction requires a reason.
stock_adjustments
-----------------
id
tenant_id
store_id
item_id
system_quantity
counted_quantity
difference
reason
approved_by
created_by
created_at
The resulting movement is:
ADJUSTMENT_IN
or:
ADJUSTMENT_OUT

676. Stock Count
Periodic physical verification:
stock_counts
------------
id
tenant_id
store_id
count_date
status
created_by
completed_at
Status:
DRAFT
IN_PROGRESS
COMPLETED
APPROVED
CANCELLED

677. Stock Count Lines
stock_count_lines
-----------------
id
tenant_id
stock_count_id
item_id
system_quantity
counted_quantity
difference
reason
Approval can generate adjustment movements.

678. Negative Stock
Recommended V1 policy:
Negative stock prohibited
An issue that exceeds available quantity fails unless the tenant explicitly enables negative-stock behavior.
This prevents silent inventory corruption.

679. Batch Tracking
Some inventory requires batch tracking.
Examples:
laboratory supplies
chemicals
consumables with expiry
Store:
batch_number
expiry_date
when configured.

680. Serial Tracking
Assets generally require serial/asset identification.
asset_serial_number
must be unique per tenant.

681. Asset Record
assets
------
id
tenant_id
item_id
asset_number
serial_number
purchase_date
purchase_cost
supplier_id
store_id
status
condition
assigned_to_type
assigned_to_id
created_at
updated_at
version
Status:
AVAILABLE
ASSIGNED
IN_REPAIR
LOST
DAMAGED
DISPOSED
RETIRED

682. Asset Number
Every asset receives a platform-generated asset number.
Example:
AST-000123
Unique per tenant.

683. Asset Assignment
asset_assignments
-----------------
id
tenant_id
asset_id
assigned_to_type
assigned_to_id
assigned_at
returned_at
status
assigned_by
returned_by
created_at
updated_at
Assignment targets may include:
TEACHER
STAFF
STUDENT
ROOM
DEPARTMENT
VEHICLE
OTHER

684. Asset Assignment History
Never overwrite previous assignments.
Example:
Laptop
 ↓
Teacher A
 ↓
Returned
 ↓
Teacher B
Every assignment remains historically available.

685. Asset Condition
NEW
GOOD
FAIR
DAMAGED
UNUSABLE
Condition changes should be audited.

686. Asset Maintenance
asset_maintenance
-----------------
id
tenant_id
asset_id
maintenance_type
reported_at
scheduled_at
completed_at
cost
vendor
description
status
created_at
updated_at
Status:
REPORTED
SCHEDULED
IN_PROGRESS
COMPLETED
CANCELLED

687. Asset Maintenance Flow
Asset
 ↓
Issue Reported
 ↓
Maintenance
 ↓
IN_REPAIR
 ↓
Completed
 ↓
AVAILABLE / ASSIGNED
The asset cannot normally be newly assigned while IN_REPAIR.

688. Asset Disposal
asset_disposals
---------------
id
tenant_id
asset_id
disposal_date
disposal_method
reason
disposal_value
approved_by
created_by
created_at
Methods:
SALE
SCRAP
DONATION
TRANSFER
OTHER
Disposal changes the asset to:
DISPOSED

689. Disposal Approval
Disposal is a sensitive operation.
Require:
permission
+
reason
+
approval
+
audit
Future configuration can add multi-level approval for high-value assets.

690. Depreciation Metadata
Do not build a complete accounting/depreciation engine unless accounting is a product requirement.
V1 can retain:
depreciation_method
useful_life
residual_value
as optional asset metadata.
Actual accounting remains outside this domain.

691. Inventory Permissions
inventory.view
inventory.manage_items
inventory.manage_categories

inventory.manage_stores
inventory.receive
inventory.issue
inventory.return
inventory.transfer

inventory.adjust
inventory.count
inventory.approve_adjustment

inventory.supplier.view
inventory.supplier.manage

inventory.report.view
inventory.export

692. Asset Permissions
asset.view
asset.create
asset.update
asset.assign
asset.return
asset.maintenance
asset.dispose
asset.approve_disposal
asset.export

693. APIs
Items:
/api/v1/inventory/items
/api/v1/inventory/items/:id
/api/v1/inventory/categories
Stores:
/api/v1/inventory/stores
/api/v1/inventory/stores/:id
Stock:
/api/v1/inventory/receipts
/api/v1/inventory/issues
/api/v1/inventory/returns
/api/v1/inventory/transfers
/api/v1/inventory/adjustments
/api/v1/inventory/counts
Assets:
/api/v1/assets
/api/v1/assets/:id
/api/v1/assets/:id/assign
/api/v1/assets/:id/return
/api/v1/assets/:id/maintenance
/api/v1/assets/:id/dispose

694. Inventory Application Services
CreateItem
CreateCategory
CreateStore

ReceiveStock
IssueStock
ReturnStock
TransferStock

CreateStockCount
CompleteStockCount
ApproveStockAdjustment

CreateSupplier
UpdateSupplier

695. Asset Application Services
CreateAsset
UpdateAsset
AssignAsset
ReturnAsset

ReportMaintenance
StartMaintenance
CompleteMaintenance

ReportLostAsset
ReportDamagedAsset

RequestDisposal
ApproveDisposal
DisposeAsset

696. Inventory Events
ItemCreated
StockReceived
StockIssued
StockReturned
StockTransferred
StockAdjusted
StockCountCompleted

AssetCreated
AssetAssigned
AssetReturned
AssetMaintenanceStarted
AssetMaintenanceCompleted
AssetLost
AssetDamaged
AssetDisposed

697. Cross-Domain Asset References
Other domains may reference assets:
Teacher
 → assigned laptop

Classroom
 → assigned projector

Transport
 → vehicle asset

Laboratory
 → equipment asset
Inventory/Asset Management remains authoritative for asset identity and lifecycle.

698. Library Integration
Library books are intentionally not generic inventory assets in the primary library model.
Library owns:
Book
Copy
Circulation
because those concepts have specialized circulation rules.
Inventory may still be used for unrelated library consumables.

699. Transport Integration
A vehicle may be represented as a Transport vehicle while also having an asset record.
Avoid two independent lifecycle authorities.
Recommended:
Asset
  ↓
Transport Vehicle Reference
Transport owns operational vehicle state; Asset Management owns the organization's asset lifecycle where the vehicle is treated as an asset.

700. Stock Concurrency
Stock operations are highly concurrency-sensitive.
Example:
Available = 10

Issue A = 7
Issue B = 7
Only one operation can consume enough stock.
Use:
transaction
row locking or optimistic version
balance revalidation

701. Stock Transaction
An issue should atomically:
validate stock
+
create issue
+
create issue lines
+
create stock movements
+
update balance projection
+
audit
+
outbox
If any step fails, the transaction rolls back.

702. Stock Balance Projection
The movement ledger remains authoritative.
stock_balances is optimized for reads.
If a reconciliation detects inconsistency:
Movement Ledger
      ↓
Rebuild Balance
A rebuild operation should be administrative and audited.

703. Asset Concurrency
Assignment must verify:
asset.status = AVAILABLE
inside the transaction.
Two administrators cannot assign the same asset simultaneously.

704. Inventory Reporting
Initial reports:
Stock Balance
Stock Movement Ledger
Low Stock
Stock Valuation
Stock Issue Report
Stock Receipt Report
Transfer Report
Stock Adjustment Report

705. Asset Reporting
Asset Register
Assigned Assets
Unassigned Assets
Maintenance Report
Lost/Damaged Assets
Disposal Report
Asset History

706. Low Stock
Items may have reorder thresholds:
item_reorder_settings
---------------------
id
tenant_id
item_id
store_id
minimum_quantity
reorder_quantity
status
Low-stock status:
quantity_available <= minimum_quantity
This is a notification/reporting trigger, not an automatic purchase.

707. Inventory Database Indexes
items:
  tenant_id, code UNIQUE

inventory_stores:
  tenant_id, code UNIQUE

stock_balances:
  tenant_id, item_id, store_id UNIQUE

stock_movements:
  tenant_id, item_id, store_id, created_at
  tenant_id, reference_type, reference_id

assets:
  tenant_id, asset_number UNIQUE
  tenant_id, serial_number UNIQUE
  tenant_id, item_id, status

asset_assignments:
  tenant_id, asset_id, status
  tenant_id, assigned_to_type, assigned_to_id

stock_transfers:
  tenant_id, reference_number UNIQUE

708. Tenant Isolation
Every inventory/asset table is tenant-scoped.
A barcode, serial number or asset code from one school must never grant access to another school's record.

709. Audit
Audit:
item creation/changes
stock receipt
stock issue
stock return
stock transfer
stock adjustment
stock count
asset assignment
asset return
maintenance
lost/damaged status
disposal
high-value overrides
Financial values such as acquisition cost should be included in the relevant audit context.

710. Inventory & Asset Module Contract
Inventory & Assets
│
├── Item Catalogue
├── Categories
├── Stores
├── Stock Ledger
├── Receipts
├── Issues
├── Returns
├── Transfers
├── Stock Counts
├── Assets
├── Assignments
├── Maintenance
└── Disposal
Primary inventory lifecycle:
Receive
 ↓
Store
 ↓
Issue / Transfer
 ↓
Return / Adjust
 ↓
Retire
Asset lifecycle:
Acquire
 ↓
Available
 ↓
Assigned
 ↓
Maintenance
 ↓
Assigned / Available
 ↓
Disposed
The critical architectural rule is:
Inventory tracks quantities and movements; Asset Management tracks individually identifiable organizational property.

Next Domain
The next specification will cover Human Resources / Staff Administration, including staff profiles, employment records, departments, positions, contracts, onboarding/offboarding, staff documents, organizational structure and integration with Teacher, Leave and payroll-related capabilities.
