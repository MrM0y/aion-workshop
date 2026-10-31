/** Dragon Lord transfer recipes are guaranteed crafts, not proficiency rolls.
 * Client-data references: https://aion2.gg/database/recipes/dark-dragon-lord-greatsword-121023012
 * https://aion2.gg/database/recipes/splendent-ebony-dragon-lord-greatsword-121023015
 * Keep this scoped to the matching donor-based family; null alone proves nothing.
 */
export function transferRates(recipe){
  if(recipe.section!=='succession'||recipe.masteryLevel!==0||recipe.yield!==1||
    !/Dragon Lord/.test(recipe.nameEn||'')||!Array.isArray(recipe.successionFrom)||
    !recipe.materials?.some(row=>row.isDonor&&row.quantity===1&&recipe.successionFrom.includes(String(row.itemId))))return null;
  return {base:1,combo:1,source:'https://aion2.gg/database/recipes/'+recipe.nameEn.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'-'+recipe.id};
}
