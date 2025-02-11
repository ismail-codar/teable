import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { axios } from '../axios';
import { registerRoute, urlBuilder } from '../utils';
import { z } from '../zod';
import { inplaceImportOptionRoSchema } from './types';
import type { IInplaceImportOptionRo } from './types';

export const INPLACE_IMPORT_TABLE = '/import/{tableId}';

export const inplaceImportTableFromFileRoute: RouteConfig = registerRoute({
  method: 'patch',
  path: INPLACE_IMPORT_TABLE,
  description: 'import table inplace',
  request: {
    params: z.object({
      tableId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: inplaceImportOptionRoSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Successfully import table inplace',
    },
  },
  tags: ['import'],
});

export const inplaceImportTableFromFile = async (
  tableId: string,
  inplaceImportRo: IInplaceImportOptionRo
) => {
  return axios.patch<void>(urlBuilder(INPLACE_IMPORT_TABLE, { tableId }), inplaceImportRo);
};
