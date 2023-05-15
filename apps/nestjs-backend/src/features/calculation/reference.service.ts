import { Injectable } from '@nestjs/common';
import type { IRecord, LinkFieldCore } from '@teable-group/core';
import { CellValueType, Relationship, FieldType, evaluate } from '@teable-group/core';
import type { Field } from '@teable-group/db-main-prisma';
import { Prisma } from '@teable-group/db-main-prisma';
import { instanceToPlain } from 'class-transformer';
import type { Knex } from 'knex';
import knex from 'knex';
import { groupBy } from 'lodash';
import type { IVisualTableDefaultField } from '../field/constant';
import { preservedFieldName } from '../field/constant';
import type { IFieldInstance } from '../field/model/factory';
import { createFieldInstanceByRaw } from '../field/model/factory';

interface ITopoItem {
  id: string;
  dependencies: string[];
}

interface IRecordItem {
  record: IRecord;
  dependencies?: IRecord | IRecord[];
}

interface ITopoItemWithRecords extends ITopoItem {
  recordItems: IRecordItem[];
}

interface ITopoLinkOrder {
  dbTableName: string;
  fieldId: string;
  foreignKeyField: string;
  relationship: Relationship;
  linkedTable: string;
}

interface IRecordRefItem {
  id: string;
  dbTableName: string;
  fieldId?: string;
  selectIn?: string;
  belongsTo?: string;
}

@Injectable()
export class ReferenceService {
  knex: ReturnType<typeof knex>;

  constructor() {
    this.knex = knex({ client: 'sqlite3' });
  }

  calculateFormula(
    field: IFieldInstance,
    dependenceFieldMap: { [fieldId: string]: IFieldInstance },
    record: IRecord
  ): unknown {
    const formula = `{${field.id}}`;

    return evaluate(formula, dependenceFieldMap, record).value;
  }

  calculate(
    field: IFieldInstance,
    fieldMap: { [fieldId: string]: IFieldInstance },
    recordItem: IRecordItem
  ) {
    const record = recordItem.record;
    // TODO: lookup and rollup field have the same logical
    if (field.type === FieldType.Link) {
      if (!recordItem.dependencies) {
        throw new Error(`Dependency should not be undefined when contains a ${field.type} field`);
      }
      const lookupField = fieldMap[field.options.lookupFieldId];

      return this.calculateRollup(field, lookupField, record, recordItem.dependencies);
    }

    return field.isComputed
      ? this.calculateFormula(field, fieldMap, record)
      : record.fields[field.id];
  }

  calculateRollup(
    field: LinkFieldCore,
    lookupField: IFieldInstance,
    record: IRecord,
    dependencies: IRecord | IRecord[]
  ): unknown {
    const formula = `{__values__}`;

    const plain = instanceToPlain(lookupField);

    const lookupValues = Array.isArray(dependencies)
      ? dependencies.map((depRecord) => depRecord.fields[lookupField.id])
      : dependencies.fields[lookupField.id];

    const cellValueType =
      field.options.relationship === Relationship.ManyOne
        ? CellValueType.Array
        : lookupField.cellValueType;

    const cellValueElementType =
      cellValueType === CellValueType.Array ? lookupField.cellValueType : undefined;

    const virtualField = createFieldInstanceByRaw({
      ...plain,
      id: '__values__',
      cellValueType,
      cellValueElementType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    return evaluate(
      formula,
      { __values__: virtualField },
      { ...record, fields: { ...record.fields, __values__: lookupValues } }
    ).value;
  }

  private async createAuxiliaryData(prisma: Prisma.TransactionClient, allFieldIds: string[]) {
    const fieldRaws = await prisma.field.findMany({
      where: { id: { in: allFieldIds } },
    });

    const fieldId2TableId = fieldRaws.reduce<{ [fieldId: string]: string }>((pre, f) => {
      pre[f.id] = f.tableId;
      return pre;
    }, {});

    const tableIds = Array.from(new Set(Object.values(fieldId2TableId)));
    const tableMeta = await prisma.tableMeta.findMany({
      where: { id: { in: tableIds } },
      select: { id: true, dbTableName: true },
    });

    const tableId2DbTableName = tableMeta.reduce<{ [tableId: string]: string }>((pre, t) => {
      pre[t.id] = t.dbTableName;
      return pre;
    }, {});

    const fieldMap = fieldRaws.reduce<{ [fieldId: string]: IFieldInstance }>((pre, f) => {
      pre[f.id] = createFieldInstanceByRaw(f);
      return pre;
    }, {});

    const dbTableName2fieldRaws = fieldRaws.reduce<{ [fieldId: string]: Field[] }>((pre, f) => {
      const dbTableName = tableId2DbTableName[f.tableId];
      if (pre[dbTableName]) {
        pre[dbTableName].push(f);
      } else {
        pre[dbTableName] = [f];
      }
      return pre;
    }, {});

    return {
      fieldMap,
      fieldId2TableId,
      dbTableName2fieldRaws,
      tableId2DbTableName,
    };
  }

  collectChanges(
    orders: ITopoItemWithRecords[],
    fieldMap: { [fieldId: string]: IFieldInstance },
    fieldId2TableId: { [fieldId: string]: string }
  ) {
    // detail changes
    const changes: {
      tableId: string;
      recordId: string;
      fieldId: string;
      oldValue: unknown;
      newValue: unknown;
    }[] = [];

    orders.forEach((item) => {
      item.recordItems.forEach((recordItem) => {
        const field = fieldMap[item.id];
        const record = recordItem.record;
        const value = this.calculate(field, fieldMap, recordItem);

        const oldValue = record.fields[field.id];
        record.fields[field.id] = value;

        if (oldValue !== value) {
          changes.push({
            tableId: fieldId2TableId[field.id],
            fieldId: field.id,
            recordId: record.id,
            oldValue,
            newValue: value,
          });
        }
      });
    });
    return changes;
  }

  async updateNodeValues(prisma: Prisma.TransactionClient, fieldId: string, recordIds: string[]) {
    const undirectedGraph = await this.getDependentNodesCTE(prisma, fieldId);
    const topoOrders = this.getTopologicalOrder(fieldId, undirectedGraph);
    const allFieldIds = this.flatGraph(undirectedGraph);
    const { fieldMap, fieldId2TableId, dbTableName2fieldRaws, tableId2DbTableName } =
      await this.createAuxiliaryData(prisma, allFieldIds);

    const linkOrders = this.getLinkOrderFromTopoOrders({
      tableId2DbTableName,
      topoOrders,
      fieldMap,
      fieldId2TableId,
    });

    // only affected records included
    const recordItems = await this.getAffectedRecordItems(prisma, recordIds, linkOrders);

    // extra dependent records for link field
    const extraRecordItems = await this.getExtraDependentRecordItems(prisma, recordItems);

    // record data source
    const dbTableName2records = await this.getRecordsBatch(prisma, {
      recordItems,
      extraRecordItems,
      dbTableName2fieldRaws,
    });

    const orderWithRecords = this.createTopoItemWithRecords({
      order: topoOrders,
      fieldMap,
      tableId2DbTableName,
      fieldId2TableId,
      dbTableName2records,
      recordRefItems: recordItems,
      extraRecordRefItems: extraRecordItems,
    });

    return this.collectChanges(orderWithRecords, fieldMap, fieldId2TableId);
  }

  private recordRaw2Record(
    fieldRaws: Field[],
    raw: { [dbFieldName: string]: unknown } & IVisualTableDefaultField
  ) {
    const fieldsData = fieldRaws.reduce<{ [fieldId: string]: unknown }>((acc, field) => {
      acc[field.id] = raw[field.dbFieldName];
      return acc;
    }, {});

    return {
      fields: fieldsData,
      id: raw.__id,
      createdTime: raw.__created_time?.getTime(),
      lastModifiedTime: raw.__last_modified_time?.getTime(),
      createdBy: raw.__created_by,
      lastModifiedBy: raw.__last_modified_by,
      recordOrder: {},
    };
  }

  getLinkOrderFromTopoOrders(params: {
    fieldId2TableId: { [fieldId: string]: string };
    tableId2DbTableName: { [tableId: string]: string };
    topoOrders: ITopoItem[];
    fieldMap: { [fieldId: string]: IFieldInstance };
  }): ITopoLinkOrder[] {
    const newOrder: ITopoLinkOrder[] = [];
    const { tableId2DbTableName, fieldId2TableId, topoOrders, fieldMap } = params;
    for (const item of topoOrders) {
      const field = fieldMap[item.id];
      const tableId = fieldId2TableId[field.id];
      const dbTableName = tableId2DbTableName[tableId];
      if (field.type === FieldType.Link) {
        const foreignKeyFieldName = field.options.dbForeignKeyName;
        const linkedTable = tableId2DbTableName[field.options.foreignTableId];

        newOrder.push({
          dbTableName,
          fieldId: field.name,
          foreignKeyField: foreignKeyFieldName,
          linkedTable,
          relationship: field.options.relationship,
        });
      }
    }
    return newOrder;
  }

  async getRecordsBatch(
    prisma: Prisma.TransactionClient,
    params: {
      dbTableName2fieldRaws: { [tableId: string]: Field[] };
      recordItems: IRecordRefItem[];
      extraRecordItems: IRecordRefItem[];
    }
  ) {
    const { recordItems, extraRecordItems, dbTableName2fieldRaws } = params;
    const recordIdsByTableName = groupBy([...recordItems, ...extraRecordItems], 'dbTableName');

    let query: Knex.QueryBuilder | undefined;
    for (const dbTableName in recordIdsByTableName) {
      // deduplication is needed
      const recordIds = Array.from(new Set(recordIdsByTableName[dbTableName].map((r) => r.id)));
      const fieldNames = dbTableName2fieldRaws[dbTableName].map((f) => f.dbFieldName);
      const aliasedFieldNames = [...fieldNames, ...preservedFieldName].map(
        (fieldName) => `${dbTableName}.${fieldName} as '${dbTableName}#${fieldName}'`
      );
      const subQuery = knex(dbTableName).select(aliasedFieldNames).whereIn('id', recordIds);
      // TODO: can i change it to union all for performance
      query = query ? query.union(subQuery) : subQuery;
    }
    if (!query) {
      throw new Error("recordItems shouldn't be empty");
    }
    const nativeSql = query.toSQL().toNative();
    console.log('getRecordSQL:', nativeSql.sql);
    const result = await prisma.$queryRawUnsafe<{ [fieldName: string]: unknown }[]>(
      nativeSql.sql,
      ...nativeSql.bindings
    );
    return this.formatRecordQueryResult(result, dbTableName2fieldRaws);
  }

  private getOneManyDependencies(params: {
    field: LinkFieldCore;
    record: IRecord;
    foreignTableRecords: IRecord[];
    extraRecordRefItems: IRecordRefItem[];
  }): IRecord[] {
    const { field, extraRecordRefItems, record, foreignTableRecords } = params;

    if (field.options.relationship !== Relationship.OneMany) {
      throw new Error("field's relationship should be OneMany");
    }
    return extraRecordRefItems
      .filter((item) => item.belongsTo === record.id && item.fieldId === field.id)
      .map((item) => {
        const record = foreignTableRecords.find((r) => r.id === item.id);
        if (!record) {
          throw new Error('Can not find link record');
        }
        return record;
      });
  }

  private getMany2OneDependency(params: {
    field: LinkFieldCore;
    record: IRecord;
    foreignTableRecords: IRecord[];
    recordRefItems: IRecordRefItem[];
  }): IRecord {
    const { field, record, recordRefItems, foreignTableRecords } = params;

    if (field.options.relationship !== Relationship.ManyOne) {
      throw new Error("field's relationship should be ManyOne");
    }

    const linkRecordRef = recordRefItems.find((item) => item.belongsTo === record.id);
    if (!linkRecordRef) {
      throw new Error('Can not find link record ref');
    }

    const linkRecord = foreignTableRecords.find((r) => r.id === linkRecordRef.belongsTo);
    if (!linkRecord) {
      throw new Error('Can not find link record');
    }
    return linkRecord;
  }

  createTopoItemWithRecords(params: {
    order: ITopoItem[];
    tableId2DbTableName: { [tableId: string]: string };
    fieldId2TableId: { [fieldId: string]: string };
    fieldMap: { [fieldId: string]: IFieldInstance };
    dbTableName2records: { [tableName: string]: IRecord[] };
    recordRefItems: IRecordRefItem[];
    extraRecordRefItems: IRecordRefItem[];
  }): ITopoItemWithRecords[] {
    const {
      order,
      fieldMap,
      tableId2DbTableName,
      fieldId2TableId,
      dbTableName2records,
      recordRefItems,
      extraRecordRefItems,
    } = params;
    const recordRefItemIndexed = groupBy(recordRefItems, 'dbTableName');
    return order.map((order) => {
      const field = fieldMap[order.id];

      const tableId = fieldId2TableId[order.id];
      const dbTableName = tableId2DbTableName[tableId];
      const records = dbTableName2records[dbTableName];

      // update link field dependency
      if (field.type === FieldType.Link) {
        const foreignTableName = tableId2DbTableName[field.options.foreignTableId];
        const foreignTableRecords = dbTableName2records[foreignTableName];
        const recordRefItems = recordRefItemIndexed[dbTableName];
        const dependenciesArr = records.map((record) => {
          if (field.options.relationship === Relationship.OneMany) {
            return this.getOneManyDependencies({
              record,
              field,
              foreignTableRecords,
              extraRecordRefItems,
            });
          }
          if (field.options.relationship === Relationship.ManyOne) {
            return this.getMany2OneDependency({
              record,
              field,
              recordRefItems,
              foreignTableRecords,
            });
          }
          throw new Error('Unsupported relationship');
        });
        return {
          ...order,
          recordItems: records.map((record, i) => ({ record, dependencies: dependenciesArr[i] })),
        };
      }

      return {
        ...order,
        recordItems: records.map((record) => ({ record })),
      };
    });
  }

  private formatRecordQueryResult(
    result: { [fieldName: string]: unknown }[],
    dbTableName2fieldRaws: { [tableId: string]: Field[] }
  ): {
    [tableName: string]: IRecord[];
  } {
    const formattedResults: {
      [tableName: string]: { [fieldKey: string]: unknown }[];
    } = {};
    result.forEach((record) => {
      for (const key in record) {
        const value = record[key];
        const recordData: { [k: string]: unknown } = {};
        if (value == null) {
          continue;
        }

        const [tableName, fieldName] = key.split('#');
        recordData[fieldName] = value;

        if (!formattedResults[tableName]) {
          formattedResults[tableName] = [];
        }

        const existingRecord = formattedResults[tableName].find(
          (r) => r.__id === record[`${tableName}__id`]
        );

        if (existingRecord) {
          existingRecord[fieldName] = record[key];
        } else {
          formattedResults[tableName].push({ [fieldName]: record[key] });
        }
      }
    });

    return Object.entries(formattedResults).reduce<{ [tableName: string]: IRecord[] }>((acc, e) => {
      const [dbTableName, records] = e;
      const fieldRaws = dbTableName2fieldRaws[dbTableName];
      acc[dbTableName] = records.map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.recordRaw2Record(fieldRaws, r as any);
      });
      return acc;
    }, {});
  }

  getTopologicalOrder(
    startNodeId: string,
    graph: { toFieldId: string; fromFieldId: string }[]
  ): ITopoItem[] {
    const visitedNodes = new Set<string>();
    const sortedNodes: ITopoItem[] = [];

    function visit(node: string) {
      if (!visitedNodes.has(node)) {
        visitedNodes.add(node);

        const incomingEdges = graph.filter((edge) => edge.toFieldId === node);
        const outgoingEdges = graph.filter((edge) => edge.fromFieldId === node);
        const dependencies: string[] = [];

        for (const edge of incomingEdges) {
          dependencies.push(edge.fromFieldId);
        }

        for (const edge of outgoingEdges) {
          visit(edge.toFieldId);
        }

        sortedNodes.push({ id: node, dependencies });
      }
    }

    visit(startNodeId);

    return sortedNodes.reverse();
  }

  async getDependentNodesCTE(prisma: Prisma.TransactionClient, startFieldId: string) {
    const dependentNodesQuery = Prisma.sql`
      WITH RECURSIVE connected_reference(from_field_id, to_field_id) AS (
        SELECT from_field_id, to_field_id FROM reference WHERE from_field_id = ${startFieldId} OR to_field_id = ${startFieldId}
        UNION
        SELECT deps.from_field_id, deps.to_field_id
        FROM reference deps
        JOIN connected_reference cd
          ON (deps.from_field_id = cd.from_field_id AND deps.to_field_id != cd.to_field_id) 
          OR (deps.from_field_id = cd.to_field_id AND deps.to_field_id != cd.from_field_id) 
          OR (deps.to_field_id = cd.from_field_id AND deps.from_field_id != cd.to_field_id) 
          OR (deps.to_field_id = cd.to_field_id AND deps.from_field_id != cd.from_field_id)
      )
      SELECT DISTINCT from_field_id, to_field_id FROM connected_reference;
    `;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const result = await prisma.$queryRaw<{ from_field_id: string; to_field_id: string }[]>(
      dependentNodesQuery
    );
    return result.map((row) => ({ fromFieldId: row.from_field_id, toFieldId: row.to_field_id }));
  }

  async getExtraDependentRecordItems(
    prisma: Prisma.TransactionClient,
    recordItems: IRecordRefItem[]
  ): Promise<IRecordRefItem[]> {
    const queries = recordItems
      .filter((item) => item.selectIn)
      .map((item) => {
        const { id, fieldId, selectIn } = item;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const [dbTableName, selectField] = selectIn!.split('.');
        return this.knex
          .select([
            `${dbTableName}.__id as id`,
            `${dbTableName}.${selectField} as belongsTo`,
            this.knex.raw(`'${dbTableName}' as dbTableName`),
            this.knex.raw(`'${fieldId}' as fieldId`),
          ])
          .from(dbTableName)
          .where(selectField, id);
      });

    const [firstQuery, ...restQueries] = queries;
    const nativeSql = firstQuery.union(restQueries).toSQL().toNative();

    return await prisma.$queryRawUnsafe<IRecordRefItem[]>(nativeSql.sql, ...nativeSql.bindings);
  }

  async getAffectedRecordItems(
    prisma: Prisma.TransactionClient,
    startIds: string[],
    topoOrder: ITopoLinkOrder[]
  ): Promise<IRecordRefItem[]> {
    // Initialize the base case for the recursive CTE)
    const initTableName = topoOrder[0].linkedTable;
    let cteQuery = `
    SELECT __id, '${initTableName}' as dbTableName, null as selectIn, null as belongsTo, null as fieldId
    FROM ${initTableName} WHERE __id IN (${startIds.map((id) => `'${id}'`).join(',')})`;

    // Iterate over the nodes in topological order
    for (let i = 0; i < topoOrder.length; i++) {
      const currentOrder = topoOrder[i];
      const { fieldId, foreignKeyField, dbTableName, linkedTable } = currentOrder;

      // Append the current node to the recursive CTE
      if (currentOrder.relationship === Relationship.OneMany) {
        cteQuery += `
        UNION
        SELECT ${linkedTable}.${foreignKeyField} as __id, '${dbTableName}' as dbTableName, '${linkedTable}.${foreignKeyField}' as selectIn , null as belongsTo, '${fieldId}' as fieldId
        FROM ${linkedTable}
        JOIN affected_records
        ON ${linkedTable}.__id = affected_records.__id
        WHERE affected_records.dbTableName = '${linkedTable}'`;
      } else {
        cteQuery += `
        UNION
        SELECT ${dbTableName}.__id, '${dbTableName}' as dbTableName, null as selectIn, affected_records.__id as belongsTo, '${fieldId}' as fieldId
        FROM ${dbTableName}
        JOIN affected_records
        ON ${dbTableName}.${foreignKeyField} = affected_records.__id
        WHERE affected_records.dbTableName = '${linkedTable}'`;
      }
    }

    // Construct the final query using the recursive CTE
    const finalQuery = `
    WITH affected_records AS (${cteQuery})
    SELECT * FROM affected_records`;

    console.log('nativeSql:', finalQuery);

    const results = await prisma.$queryRawUnsafe<
      {
        __id: string;
        dbTableName: string;
        selectIn?: string;
        fieldId?: string;
        belongsTo?: string;
      }[]
    >(finalQuery);

    return results.map((record) => ({
      id: record.__id,
      dbTableName: record.dbTableName,
      ...(record.belongsTo ? { belongsTo: record.belongsTo } : {}),
      ...(record.fieldId ? { fieldId: record.fieldId } : {}),
      ...(record.selectIn ? { selectIn: record.selectIn } : {}),
    }));
  }

  private flatGraph(graph: { toFieldId: string; fromFieldId: string }[]) {
    const allNodes = new Set<string>();
    for (const edge of graph) {
      allNodes.add(edge.fromFieldId);
      allNodes.add(edge.toFieldId);
    }
    return Array.from(allNodes);
  }
}
