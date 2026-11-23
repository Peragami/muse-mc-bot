// Shared constants + env config for the Muze bot modules.
const LOG_TYPES = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'];
const PLANK_OF = { oak_log:'oak_planks', birch_log:'birch_planks', spruce_log:'spruce_planks', jungle_log:'jungle_planks', acacia_log:'acacia_planks', dark_oak_log:'dark_oak_planks', mangrove_log:'mangrove_planks', cherry_log:'cherry_planks' };
const HOSTILES = new Set(['zombie','skeleton','creeper','spider','enderman','witch','pillager','vindicator','drowned','husk','stray','phantom','slime','magma_cube','blaze','ghast','piglin','hoglin','ravager','vex','evoker','guardian','elder_guardian','shulker','silverfish','endermite','cave_spider','zombie_villager','zombified_piglin','piglin_brute','warden','bogged','breeze']);
const REPLACEABLE_CELLS = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dandelion', 'poppy', 'oxeye_daisy', 'azure_bluet', 'dead_bush']);
const JP_CRAFT = { '木のツルハシ':'wooden_pickaxe','石のツルハシ':'stone_pickaxe','作業台':'crafting_table','棒':'stick','松明':'torch','つるはし':'wooden_pickaxe','ツルハシ':'wooden_pickaxe' };
const JP_ITEMS = { '木':'oak_log','原木':'oak_log','板材':'oak_planks','石':'cobblestone','鉄':'iron_ingot','棒':'stick','作業台':'crafting_table','松明':'torch','パン':'bread','糸':'string' };
const FOOD_ORDER = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'bread', 'baked_potato', 'pumpkin_pie', 'carrot', 'golden_carrot', 'apple', 'melon_slice', 'sweet_berries', 'glow_berries', 'beef', 'porkchop', 'mutton', 'chicken', 'cod', 'salmon', 'potato', 'rotten_flesh', 'spider_eye'];
const PREY = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const DEPOSIT_KEEP = (name) => /(_pickaxe|_axe|_sword|_shovel|_hoe)$/.test(name) || name === 'fishing_rod';
const ARMOR_PLAN = [
  ['iron_pickaxe', 3], ['iron_chestplate', 8], ['iron_leggings', 7], ['iron_helmet', 5], ['iron_boots', 4],
];
module.exports = {
  LOG_TYPES, PLANK_OF, HOSTILES, REPLACEABLE_CELLS, JP_CRAFT, JP_ITEMS, FOOD_ORDER, PREY, DEPOSIT_KEEP, ARMOR_PLAN,
  HOST: process.env.MC_HOST || '127.0.0.1',
  PORT: parseInt(process.env.MC_PORT || '25565', 10),
  USERNAME: process.env.MC_USER || 'Muze',
  PROXY: process.env.MC_PROXY || '',
  VIEWER_PORT: process.env.VIEWER_PORT ? parseInt(process.env.VIEWER_PORT, 10) : 0,
  STATE_PORT: process.env.STATE_PORT ? parseInt(process.env.STATE_PORT, 10) : 0,
  AUTOSOLO: process.env.AUTOSOLO === '1',
};
