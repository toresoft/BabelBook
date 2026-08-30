-- A stylesheet or a script is not a translation unit.
--
-- Extraction used to cut one at every `<style>` and `<script>`, mark it
-- 'never-translated' and put it on the exclusions screen — where the only
-- thing offered for it is a button that hands CSS to a translator. It no
-- longer cuts them; this removes the ones the books analysed before then
-- still carry. Composition does not miss them: a unit with no translation
-- gives its range back byte for byte, and so does a range no unit covers.
--
-- Untouched ones only. A unit the user forced is their decision and not ours
-- to delete, and one that owns an attribute unit would leave it orphaned.
DELETE FROM unit AS u
 WHERE u.state = 'never-translated'
   AND u.forced_state IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM unit o
      WHERE o.project_id = u.project_id AND o.owner_unit_id = u.unit_id
   );
