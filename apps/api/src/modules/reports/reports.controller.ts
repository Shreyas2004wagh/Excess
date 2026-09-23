import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import type { ClerkIdentity } from '../auth/auth.types.js';
import { parseReportQuery } from './report-query.js';
import { ReportsService } from './reports.service.js';

@Controller('reports/trading')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  getReport(
    @CurrentIdentity() identity: ClerkIdentity,
    @Query() query: Record<string, unknown>,
  ) {
    return this.reports.getReport(identity, parseReportQuery(query));
  }

  @Get('export')
  @Header('Cache-Control', 'private, no-store')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(
    @CurrentIdentity() identity: ClerkIdentity,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (query.cursor !== undefined || query.limit !== undefined) {
      throw new BadRequestException({
        code: 'INVALID_REPORT_QUERY',
        message:
          'Exports include the full filtered range; omit cursor and limit.',
      });
    }
    const parsed = parseReportQuery(query);
    const csv = await this.reports.exportCsv(identity, parsed);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="excess-trades-${parsed.filters.from}-${parsed.filters.to}.csv"`,
    );
    return csv;
  }
}
