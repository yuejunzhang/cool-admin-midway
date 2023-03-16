import { App, IMidwayApplication } from '@midwayjs/core';
import { ALL, Config, Inject, Provide } from '@midwayjs/decorator';
import { BaseService, CoolCommException } from '@cool-midway/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { BaseSysMenuEntity } from '../../entity/sys/menu';
import * as _ from 'lodash';
import { BaseSysPermsService } from './perms';
import { Context } from '@midwayjs/koa';
import { TempDataSource } from './data';
// eslint-disable-next-line node/no-unpublished-import
import * as ts from 'typescript';
import * as fs from 'fs';
import * as pathUtil from 'path';

/**
 * 菜单
 */
@Provide()
export class BaseSysMenuService extends BaseService {
  @Inject()
  ctx: Context;

  @InjectEntityModel(BaseSysMenuEntity)
  baseSysMenuEntity: Repository<BaseSysMenuEntity>;

  @Inject()
  baseSysPermsService: BaseSysPermsService;

  @Config(ALL)
  config;

  @App()
  app: IMidwayApplication;

  /**
   * 获得所有菜单
   */
  async list() {
    const menus = await this.getMenus(
      this.ctx.admin.roleIds,
      this.ctx.admin.username === 'admin'
    );
    if (!_.isEmpty(menus)) {
      menus.forEach(e => {
        const parentMenu = menus.filter(m => {
          e.parentId = parseInt(e.parentId);
          if (e.parentId == m.id) {
            return m.name;
          }
        });
        if (!_.isEmpty(parentMenu)) {
          e.parentName = parentMenu[0].name;
        }
      });
    }
    return menus;
  }

  /**
   * 修改之后
   * @param param
   */
  async modifyAfter(param) {
    if (param.id) {
      await this.refreshPerms(param.id);
    }
  }

  /**
   * 根据角色获得权限信息
   * @param {[]} roleIds 数组
   */
  async getPerms(roleIds) {
    let perms = [];
    if (!_.isEmpty(roleIds)) {
      const result = await this.nativeQuery(
        `SELECT a.perms FROM base_sys_menu a ${this.setSql(
          !roleIds.includes('1'),
          'JOIN base_sys_role_menu b on a.id = b.menuId AND b.roleId in (?)',
          [roleIds]
        )}
            where 1=1 and a.perms is not NULL
            `,
        [roleIds]
      );
      if (result) {
        result.forEach(d => {
          if (d.perms) {
            perms = perms.concat(d.perms.split(','));
          }
        });
      }
      perms = _.uniq(perms);
      perms = _.remove(perms, n => {
        return !_.isEmpty(n);
      });
    }
    return _.uniq(perms);
  }

  /**
   * 获得用户菜单信息
   * @param roleIds
   * @param isAdmin 是否是超管
   */
  async getMenus(roleIds, isAdmin) {
    return await this.nativeQuery(`
        SELECT
            a.*
        FROM
            base_sys_menu a
        ${this.setSql(
          !isAdmin,
          'JOIN base_sys_role_menu b on a.id = b.menuId AND b.roleId in (?)',
          [roleIds]
        )}
        GROUP BY a.id
        ORDER BY
            orderNum ASC`);
  }

  /**
   * 删除
   * @param ids
   */
  async delete(ids) {
    let idArr;
    if (ids instanceof Array) {
      idArr = ids;
    } else {
      idArr = ids.split(',');
    }
    for (const id of idArr) {
      await this.baseSysMenuEntity.delete({ id });
      await this.delChildMenu(id);
    }
  }

  /**
   * 删除子菜单
   * @param id
   */
  private async delChildMenu(id) {
    await this.refreshPerms(id);
    const delMenu = await this.baseSysMenuEntity.findBy({ parentId: id });
    if (_.isEmpty(delMenu)) {
      return;
    }
    const delMenuIds = delMenu.map(e => {
      return e.id;
    });
    await this.baseSysMenuEntity.delete(delMenuIds);
    for (const menuId of delMenuIds) {
      await this.delChildMenu(menuId);
    }
  }

  /**
   * 更新权限
   * @param menuId
   */
  async refreshPerms(menuId) {
    const users = await this.nativeQuery(
      'select b.userId from base_sys_role_menu a left join base_sys_user_role b on a.roleId = b.roleId where a.menuId = ? group by b.userId',
      [menuId]
    );
    // 刷新admin权限
    await this.baseSysPermsService.refreshPerms(1);
    if (!_.isEmpty(users)) {
      // 刷新其他权限
      for (const user of users) {
        await this.baseSysPermsService.refreshPerms(user.userId);
      }
    }
  }

  /**
   * 解析实体和Controller
   * @param entityString
   * @param controller
   * @param module
   */
  async parse(entityString: string, controller: string, module: string) {
    const tempDataSource = new TempDataSource({
      ...this.config.typeorm.dataSource.default,
      entities: [],
    });
    // 连接数据库
    await tempDataSource.initialize();
    const { newCode, className } = this.parseCode(entityString);
    const code = ts.transpile(
      `${newCode}
        tempDataSource.options.entities.push(${className})
        `,
      {
        emitDecoratorMetadata: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2018,
        removeComments: true,
      }
    );
    eval(code);
    await tempDataSource.buildMetadatas();
    const columns = tempDataSource.getMetadata(className).columns;
    await tempDataSource.destroy();
    const fileName = await this.fileName(controller);
    return {
      columns: columns.map(e => {
        return {
          propertyName: e.propertyName,
          type: typeof e.type == 'string' ? e.type : e.type.name.toLowerCase(),
          length: e.length,
          comment: e.comment,
          nullable: e.isNullable,
        };
      }),
      path: `/admin/${module}/${fileName}`,
    };
  }

  /**
   * 解析Entity类名
   * @param code
   * @returns
   */
  parseCode(code: string) {
    try {
      const oldClassName = code
        .match('class(.*)extends')[1]
        .replace(/\s*/g, '');
      const oldTableStart = code.indexOf('@Entity(');
      const oldTableEnd = code.indexOf(')');

      const oldTableName = code
        .substring(oldTableStart + 9, oldTableEnd - 1)
        .replace(/\s*/g, '')
        // eslint-disable-next-line no-useless-escape
        .replace(/\"/g, '')
        // eslint-disable-next-line no-useless-escape
        .replace(/\'/g, '');
      const className = `${oldClassName}TEMP`;
      return {
        newCode: code
          .replace(oldClassName, className)
          .replace(oldTableName, `func_${oldTableName}`),
        className,
        tableName: `func_${oldTableName}`,
      };
    } catch (err) {
      throw new CoolCommException('代码结构不正确，请检查');
    }
  }

  /**
   *  创建代码
   * @param body body
   */
  async create(body) {
    const { module, entity, controller } = body;
    const basePath = this.app.getBaseDir();
    const fileName = await this.fileName(controller);
    // 生成Entity
    const entityPath = pathUtil.join(
      basePath,
      'modules',
      module,
      'entity',
      `${fileName}.ts`
    );
    // 生成Controller
    const controllerPath = pathUtil.join(
      basePath,
      'modules',
      module,
      'controller',
      'admin',
      `${fileName}.ts`
    );
    this.createConfigFile(module);
    this.createFile(entityPath, entity);
    this.createFile(controllerPath, controller);
  }

  /**
   * 创建配置文件
   * @param module
   */
  async createConfigFile(module: string) {
    const basePath = this.app.getBaseDir();
    const configFilePath = pathUtil.join(
      basePath,
      'modules',
      module,
      'config.ts'
    );
    if (!fs.existsSync(configFilePath)) {
      const data = `import { ModuleConfig } from '@cool-midway/core';

/**
 * 模块配置
 */
export default () => {
  return {
    // 模块名称
    name: 'xxx',
    // 模块描述
    description: 'xxx',
    // 中间件，只对本模块有效
    middlewares: [],
    // 中间件，全局有效
    globalMiddlewares: [],
    // 模块加载顺序，默认为0，值越大越优先加载
    order: 0,
  } as ModuleConfig;
};
`;
      await this.createFile(configFilePath, data);
    }
  }

  /**
   * 找到文件名
   * @param controller
   * @returns
   */
  async fileName(controller: string) {
    const regex = /import\s*{\s*\w+\s*}\s*from\s*'[^']*\/([\w-]+)';/;
    const match = regex.exec(controller);

    if (match && match.length > 1) {
      return match[1];
    }

    return null;
  }

  /**
   * 创建文件
   * @param filePath
   * @param content
   */
  async createFile(filePath: string, content: string) {
    const folderPath = pathUtil.dirname(filePath);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    fs.writeFileSync(filePath, content);
  }
}
